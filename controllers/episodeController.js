import models from '../models/index.js';
import { listSegmentFiles, getSignedUrl, downloadFromGCS, uploadTextToGCS, uploadHLSFolderToGCS, getUploadSignedUrl,listSegmentFilesForTranscode } from '../services/gcsStorage.js';
import { TranscoderServiceClient } from '@google-cloud/video-transcoder';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import convertToHLS from '../utils/convertToHLS.js';

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

  // Validate inputs
  if (!Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({ error: 'Videos array is required' });
  }
  if (!series_id || !episode_number) {
    return res.status(400).json({ error: 'series_id and episode_number are required' });
  }

  let episode;
  try {
    // Step 1: Create Episode
    const series = await Series.findByPk(series_id);
    if (!series) {
      return res.status(400).json({ error: 'Series not found' });
    }

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
      const { gcsFilePath, language} = video;
      if (!isValidGcsUri(gcsFilePath)) {
        throw new Error(`Invalid or missing GCS file path for language ${language}. Must start with gs://`);
      }
      // Step 2: Transcode to HLS
      const uniqueOutputFolder = `hls_output/${uuidv4()}/`;
      const outputBaseUri = `gs://${outputBucketName}/${uniqueOutputFolder}`;
      const projectId = await transcoderClient.getProjectId();
      const jobConfig = {
        elementaryStreams: [
          { key: 'video-sd', videoStream: { codec: 'h264', h264: { heightPixels: 360, widthPixels: 640, bitrateBps: 800000, frameRate: 30 } } },
          { key: 'video-hd', videoStream: { codec: 'h264', h264: { heightPixels: 720, widthPixels: 1280, bitrateBps: 2500000, frameRate: 30 } } },
          { key: 'audio-stereo', audioStream: { codec: 'aac', bitrateBps: 128000, channelCount: 2 } },
        ],
        muxStreams: [
          { key: 'sd', container: 'ts', elementaryStreams: ['video-sd', 'audio-stereo'] },
          { key: 'hd', container: 'ts', elementaryStreams: ['video-hd', 'audio-stereo'] },
        ],
        manifests: [{ fileName: 'playlist.m3u8', type: 'HLS', muxStreams: ['sd', 'hd'] }],
      };
      const request = {
        parent: `projects/${projectId}/locations/${location}`,
        job: { inputUri: gcsFilePath, outputUri: outputBaseUri, config: jobConfig },
      };
      const [operation] = await transcoderClient.createJob(request);
      const jobName = operation.name;
      // Poll for job completion
      let jobState = 'PENDING';
      let jobResult;
      const startTime = Date.now();
      const timeout = 10 * 60 * 1000;
      while (jobState !== 'SUCCEEDED' && jobState !== 'FAILED' && Date.now() - startTime < timeout) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        [jobResult] = await transcoderClient.getJob({ name: jobName });
        jobState = jobResult.state;
      }
      if (jobState !== 'SUCCEEDED') {
        throw new Error(jobState === 'FAILED' ? `Transcoding job failed: ${jobResult.error?.message || 'Unknown error'}` : 'Transcoding job timed out');
      }
      // Step 3: Generate signed URLs for playlist and segments
      const hlsPlaylistGcsPath = `${outputBaseUri}playlist.m3u8`;
      const gcsFolder = hlsPlaylistGcsPath.replace(/playlist\.m3u8$/, '');
      const segmentFiles = await listSegmentFilesForTranscode(gcsFolder);
      if (!segmentFiles.length) {
        throw new Error(`No segment files found in output folder for language ${language}`);
      }
      // Only keep HD .ts file for storage
      const hdSegmentFile = segmentFiles.find(f => /\/hd\d+\.ts$/.test(f));
      // Convert full gs://... URIs to object paths for signing
      const segmentObjectPaths = segmentFiles.map(seg => seg.replace(`gs://${outputBucketName}/`, ''));
      // Generate signed URLs for segments
      const segmentSignedUrls = {};
      await Promise.all(
        segmentObjectPaths.map(async (seg, idx) => {
          segmentSignedUrls[segmentFiles[idx]] = await getSignedUrl(seg, 60 * 24 * 7);
        })
      );
      // For playlist, extract object path
      const playlistObjectPath = hlsPlaylistGcsPath.replace(`gs://${outputBucketName}/`, '');
      // Update playlist with signed segment URLs
      let playlistText = await downloadFromGCS(playlistObjectPath);
      playlistText = playlistText.replace(/^(.*\.ts)$/gm, (match) => {
        const fullPath = segmentFiles.find(f => f.endsWith('/' + match));
        return fullPath && segmentSignedUrls[fullPath] ? segmentSignedUrls[fullPath] : match;
      });
      await uploadTextToGCS(playlistObjectPath, playlistText, 'application/x-mpegURL');
      // Generate signed URL for playlist
      const signedPlaylistUrl = await getSignedUrl(playlistObjectPath, 60 * 24 * 7);
      // Generate signed URL for HD and SD .ts files if available
      let hdTsSignedUrl = null;
      let sdTsSignedUrl = null;
      if (hdSegmentFile) {
        const hdTsObjectPath = hdSegmentFile.replace(`gs://${outputBucketName}/`, '');
        hdTsSignedUrl = await getSignedUrl(hdTsObjectPath, 60 * 24 * 7);
      }
      /*const sdSegmentFile = segmentFiles.find(f => /\/sd\d+\.ts$/.test(f));
      if (sdSegmentFile) {
        const sdTsObjectPath = sdSegmentFile.replace(`gs://${outputBucketName}/`, '');
        sdTsSignedUrl = await getSignedUrl(sdTsObjectPath, 60 * 24 * 7);
      }*/
      // Step 4: Add to subtitles array
      subtitles.push({
        gcsPath: hlsPlaylistGcsPath.replace(`gs://${outputBucketName}/`, ''),
        language,
        videoUrl: hdTsSignedUrl,
        hdTsPath: hdSegmentFile ? hdSegmentFile.replace(`gs://${outputBucketName}/`, '') : null,
       
      });
    }
    episode.subtitles = subtitles;
    await episode.save();
    res.json({
      message: 'Transcoding and episode creation successful',
      episodeId: episode.id,
      subtitles,
    });
  } catch (error) {
    if (episode) {
      await episode.destroy();
    }
    res.status(500).json({
      error: error.message || 'Failed to process videos',
    });
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
          id: { [models.Sequelize.Op.ne]: id }
        }
      });
      if (exists) {
        return res.status(400).json({ error: 'Episode number already exists in this series' });
      }
      episode.episode_number = episode_number;
    }
    if (typeof title !== 'undefined') episode.title = title;
    if (typeof description !== 'undefined') episode.description = description;
    await episode.save();
    res.json({ message: 'Episode updated successfully', id: episode.id });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update episode' });
  }
};