import models from '../models/index.js';
import { listSegmentFiles, getSignedUrl, downloadFromGCS, uploadTextToGCS, uploadHLSFolderToGCS, getUploadSignedUrl,listSegmentFilesForTranscode } from '../services/gcsStorage.js';
import { TranscoderServiceClient } from '@google-cloud/video-transcoder';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import convertToHLS from '../utils/convertToHLS.js';
import { Op } from 'sequelize';

const location = 'asia-south1'; // Set your region
const outputBucketName = 'run-sources-tuktuki-464514-asia-south1'; // Set your output bucket
const transcoderClient = new TranscoderServiceClient();
const storageClient = new Storage();

function isValidGcsUri(uri) {
  return typeof uri === 'string' && uri.startsWith('gs://') && uri.length > 5;
}

async function getSignedUrlForGcs(gcsFilePath, expirationSeconds = 3600) {
  const pathParts = gcsFilePath.replace('gs://', '').split('/');
  const bucketName = pathParts.shift(); // First part is the bucket name
  const fileName = pathParts.join('/'); // The rest is the object path
  const options = {
    version: 'v4',
    action: 'read',
    expires: Date.now() + expirationSeconds * 1000,
  };
  const [url] = await storageClient.bucket(bucketName).file(fileName).getSignedUrl(options);
  return url;
}


const { Episode, Series } = models;

export const getEpisodeHlsUrl = async (req, res) => {
  try {
    const { id } = req.params;
    const { lang } = req.query;
    if (!lang) {
      return res.status(400).json({ error: 'Language code (lang) is required as a query parameter.' });
    }
    const episode = await Episode.findByPk(id);
    if (!episode) {
      return res.status(404).json({ error: 'Episode not found.' });
    }
    if (!Array.isArray(episode.subtitles)) {
      return res.status(404).json({ error: 'No subtitles/HLS info found for this episode.' });
    }
    const subtitle = episode.subtitles.find(s => s.language === lang);
    if (!subtitle || !subtitle.gcsPath) {
      return res.status(404).json({ error: 'No HLS video found for the requested language.' });
    }
    const gcsFolder = subtitle.gcsPath.replace(/playlist\.m3u8$/, '');
    const segmentFiles = await listSegmentFiles(gcsFolder);
    const segmentSignedUrls = {};
    await Promise.all(segmentFiles.map(async (seg) => {
      segmentSignedUrls[seg] = await getSignedUrl(seg, 3600);
    }));
    let playlistText = await downloadFromGCS(subtitle.gcsPath);
    playlistText = playlistText.replace(/^(segment_\d+\.ts)$/gm, (match) => segmentSignedUrls[`${gcsFolder}${match}`] || match);
    await uploadTextToGCS(subtitle.gcsPath, playlistText, 'application/x-mpegURL');
    const signedUrl = await getSignedUrl(subtitle.gcsPath, 3600);
    return res.json({ signedUrl });
  } catch (error) {
    console.error('Error generating HLS signed URL:', error);
    res.status(500).json({ error: error.message || 'Failed to generate signed URL' });
  }
};

export const uploadMultilingual = async (req, res) => {
  let tempDirs = [];
  try {
    const { title, episode_number, series_id, video_languages } = req.body;
    if (!episode_number || !series_id) {
      return res.status(400).json({ error: 'Title, episode number, and series ID are required' });
    }
    let languages;
    try {
      languages = JSON.parse(video_languages);
      if (!Array.isArray(languages)) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Invalid languages format' });
    }
    const videoFiles = req.files.videos || [];
    if (videoFiles.length !== languages.length) {
      return res.status(400).json({ error: 'Video and language count mismatch' });
    }
    const series = await Series.findByPk(series_id);
    if (!series) {
      return res.status(400).json({ error: 'Series not found' });
    }
    const subtitles = await Promise.all(
      videoFiles.map(async (file, i) => {
        const lang = languages[i];
        const hlsId = uuidv4();
        const hlsDir = path.join('/tmp', hlsId);
        await fs.mkdir(hlsDir, { recursive: true });
        tempDirs.push(hlsDir);
        try {
          await convertToHLS(file.buffer, hlsDir);
          const gcsFolder = `hls/${hlsId}/`;
          await uploadHLSFolderToGCS(hlsDir, gcsFolder);
          const segmentFiles = await listSegmentFiles(gcsFolder);
          const segmentSignedUrls = {};
          await Promise.all(segmentFiles.map(async (seg) => {
            segmentSignedUrls[seg] = await getSignedUrl(seg, 60 * 24 * 7);
          }));
          const playlistPath = `${gcsFolder}playlist.m3u8`;
          let playlistText = await downloadFromGCS(playlistPath);
          playlistText = playlistText.replace(/^(segment_\d+\.ts)$/gm, (match) => segmentSignedUrls[`${gcsFolder}${match}`] || match);
          await uploadTextToGCS(playlistPath, playlistText, 'application/x-mpegURL');
          const signedUrl = await getSignedUrl(playlistPath);
          return {
            language: lang,
            gcsPath: playlistPath,
            videoUrl: signedUrl
          };
        } catch (error) {
          console.error(`Error processing video for language ${lang}:`, error);
          throw error;
        }
      })
    );
    const episode = await Episode.create({
      title,
      episode_number,
      series_id: series.id,
      description: req.body.episode_description || null,
      reward_cost_points: req.body.reward_cost_points || 0,
      subtitles: subtitles
    });
    res.status(201).json({
      success: true,
      episode,
      signedUrls: subtitles.map(s => ({ language: s.language, url: s.videoUrl }))
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      error: 'Video upload failed',
      details: error.message
    });
  } finally {
    await Promise.all(
      tempDirs.map(dir =>
        fs.rm(dir, { recursive: true, force: true })
          .catch(e => console.error('Cleanup error:', e))
    ));
  }
};

export const generateLanguageVideoUploadUrls = async (req, res) => {
  try {
    const { videos = [], folder = 'videos' } = req.body;
    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'No videos specified' });
    }
    if (videos.length > 2) {
      return res.status(400).json({ error: 'Maximum of 2 videos allowed' });
    }
    if (!videos.every(v => /^[a-z]{2}(-[a-z]{2})?$/.test(v.language))) {
      return res.status(400).json({ error: 'Invalid language code in videos array' });
    }

    const results = [];
    for (const { language, extension = '.mp4' } of videos) {
      const langFolder = language ? `${folder}/${language}` : folder;
      const { url, gcsPath } = await getUploadSignedUrl(langFolder, extension);
      results.push({ language, uploadUrl: url, gcsPath });
    }
    res.json({ uploads: results });
  } catch (error) {
    console.error('[generateLanguageVideoUploadUrls] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate upload URLs' });
  }
};


// --- MODIFIED FUNCTION ---
export const transcodeMp4ToHls = async (req, res) => {
  console.log('[transcodeMp4ToHls] Received request.');
  const { series_id, episode_number, title, episode_description, videos } = req.body;

  if (!Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({ error: 'Videos array is required' });
  }
  if (!series_id || !episode_number) {
    return res.status(400).json({ error: 'series_id and episode_number are required' });
  }

  let episode;
  try {
    const series = await Series.findByPk(series_id);
    if (!series) return res.status(400).json({ error: 'Series not found' });

    episode = await Episode.create({
      title: title || `Episode ${episode_number}`,
      episode_number,
      series_id,
      description: episode_description || null,
      reward_cost_points: 0,
      subtitles: [],
    });

    const subtitles = [];

    for (const video of videos) {
      const { gcsFilePath, language } = video;
      if (!isValidGcsUri(gcsFilePath)) throw new Error(`Invalid GCS path for ${language}`);

      const outputFolder = `hls_output/${uuidv4()}/`;
      const outputUri = `gs://${outputBucketName}/${outputFolder}`;
      const projectId = await transcoderClient.getProjectId();

      const jobConfig = {
        elementaryStreams: [
          { key: 'video-sd', videoStream: { h264: { heightPixels: 360, widthPixels: 640, bitrateBps: 800000, frameRate: 30 } } },
          { key: 'video-hd', videoStream: { h264: { heightPixels: 720, widthPixels: 1280, bitrateBps: 2500000, frameRate: 30 } } },
          { key: 'audio-stereo', audioStream: { codec: 'aac', bitrateBps: 128000, channelCount: 2 } },
        ],
        muxStreams: [
          { key: 'sd', container: 'ts', elementaryStreams: ['video-sd', 'audio-stereo'] },
          { key: 'hd', container: 'ts', elementaryStreams: ['video-hd', 'audio-stereo'] },
        ],
        manifests: [{ fileName: 'playlist.m3u8', type: 'HLS', muxStreams: ['hd'] }],
      };

      const request = {
        parent: `projects/${projectId}/locations/${location}`,
        job: { inputUri: gcsFilePath, outputUri, config: jobConfig },
      };

      const [operation] = await transcoderClient.createJob(request);
      const jobName = operation.name;
      const timeout = 10 * 60 * 1000;
      const start = Date.now();
      let jobState = 'PENDING';
      let jobResult;

      while (Date.now() - start < timeout) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        [jobResult] = await transcoderClient.getJob({ name: jobName });
        jobState = jobResult.state;
        if (['SUCCEEDED', 'FAILED'].includes(jobState)) break;
      }

      if (jobState !== 'SUCCEEDED') {
        throw new Error(jobState === 'FAILED'
          ? `Transcoding failed: ${jobResult.error?.message}`
          : 'Transcoding timeout');
      }

      const playlistPath = `${outputFolder}playlist.m3u8`;
      const gcsFolder = `gs://${outputBucketName}/${outputFolder}`;
      const segmentFiles = await listSegmentFilesForTranscode(gcsFolder);

      const hdSegmentFiles = segmentFiles.filter(f => f.includes('/hd') && f.endsWith('.ts'));
      if (!hdSegmentFiles.length) throw new Error(`No HD segments found in ${gcsFolder}`);

      const segmentSignedUrls = {};
      await Promise.all(hdSegmentFiles.map(async (segPath) => {
        const relativePath = segPath.replace(`gs://${outputBucketName}/`, '');
        segmentSignedUrls[relativePath] = await getSignedUrl(relativePath, 60 * 24 * 7);
      }));

      let playlistText = await downloadFromGCS(playlistPath);
      const lines = playlistText.split('\n');
      const newPlaylist = lines.map(line => {
        if (line.endsWith('.ts')) {
          const filename = line.trim();
          return segmentSignedUrls[`${outputFolder}${filename}`] || '';
        }
        return line;
      }).filter(Boolean).join('\n');

      await uploadTextToGCS(playlistPath, newPlaylist);
      const signedPlaylistUrl = await getSignedUrl(playlistPath, 60 * 24 * 7);
      const firstSegmentPath = hdSegmentFiles[0].replace(`gs://${outputBucketName}/`, '');
      const hdTsSignedUrl = await getSignedUrl(firstSegmentPath, 60 * 24 * 7);

      subtitles.push({
        gcsPath: playlistPath,
        language,
        videoUrl: hdTsSignedUrl,
        playlistUrl: signedPlaylistUrl,
        hdTsPath: firstSegmentPath,
      });
    }

    episode.subtitles = subtitles;
    await episode.save();

    res.json({
      message: 'HLS Transcoding successful',
      episodeId: episode.id,
      subtitles,
    });

  } catch (error) {
    console.error('[transcodeMp4ToHls] Error:', error);
    if (episode) await episode.destroy();
    res.status(500).json({ error: error.message || 'Transcoding failed' });
  }
};



export const deleteEpisode = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Episode id is required' });
    }
    const episode = await Episode.findByPk(id);
    if (!episode) {
      return res.status(404).json({ error: 'Episode not found' });
    }
    await episode.destroy();
    res.json({ message: 'Episode deleted successfully', id });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to delete episode' });
  }
};

export const updateEpisode = async (req, res) => {
  try {
    const { id, episode_number, title, description } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Episode id is required' });
    }
    const episode = await Episode.findByPk(id);
    if (!episode) {
      return res.status(404).json({ error: 'Episode not found' });
    }
    // If episode_number is being updated, check for uniqueness in the same series
    if (typeof episode_number !== 'undefined' && episode_number !== episode.episode_number) {
      const exists = await Episode.findOne({
        where: {
          episode_number,
          series_id: episode.series_id,
          id: { [Op.ne]: id }
        }
      });
      if (exists) {
        return res.status(400).json({ error: 'Episode number already exists in this series' });
      }
      episode.episode_number = episode_number;
    }
    if (typeof title !== 'undefined') episode.title = title;
    if (typeof description !== 'undefined') episode.description = description;
    episode.updated_at = new Date();
    await episode.save();
    res.json({ message: 'Episode updated successfully', id: episode.id, updated_at: episode.updated_at });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update episode' });
  }
};