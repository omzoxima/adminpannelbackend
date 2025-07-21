import models from '../models/index.js';
import { listSegmentFiles, getSignedUrl, downloadFromGCS, uploadTextToGCS, uploadHLSFolderToGCS, getUploadSignedUrl } from '../services/gcsStorage.js';
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
    const results = [];
    for (const { language, extension = '.mp4' } of videos) {
      const langFolder = language ? `${folder}/${language}` : folder;
      const { url, gcsPath } = await getUploadSignedUrl(langFolder, extension);
      results.push({ language, uploadUrl: url, gcsPath });
    }
    res.json({ uploads: results });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to generate upload URLs' });
  }
};


// --- MODIFIED FUNCTION ---
export const transcodeMp4ToHls = async (req, res) => {
  console.log('[transcodeMp4ToHls] Received request.');
  const { gcsFilePath, series_id, episode_number, title, episode_description, language = 'en' } = req.body;

  // Input validation...
  if (!isValidGcsUri(gcsFilePath) || !series_id || !episode_number) {
    return res.status(400).json({ error: 'Valid gcsFilePath, series_id, and episode_number are required.' });
  }

  let episode;
  try {
    // Step 1: Create Episode (no changes here)
    const series = await Series.findByPk(series_id);
    if (!series) return res.status(404).json({ error: 'Series not found' });

    episode = await Episode.create({
      title: title || `Episode ${episode_number}`,
      episode_number,
      series_id,
      description: episode_description || null,
      subtitles: [],
    });
    console.log(`[transcodeMp4ToHls] Episode created: ID ${episode.id}`);

    // Step 2: Transcode to HLS (no changes to the job config)
    const uniqueOutputFolder = `hls_output/${uuidv4()}/`;
    const outputBaseUri = `gs://${outputBucketName}/${uniqueOutputFolder}`;
    const projectId = await transcoderClient.getProjectId();
    const jobConfig = { /* ... your existing job config ... */ };
    const request = { /* ... your existing job request ... */ };

    console.log('[transcodeMp4ToHls] Creating transcoder job...');
    const [operation] = await transcoderClient.createJob(request);
    await operation.promise(); // Wait for job to complete. Cleaner than polling.
    console.log('[transcodeMp4ToHls] Transcoding job completed successfully.');

    // Step 4: Generate Signed URLs for the HD Playlist and its Segments
    console.log('[transcodeMp4ToHls] Processing HD stream...');

    const hdFolderGcsPath = `${outputBaseUri}hd/`;
    const hdPlaylistGcsPath = `${hdFolderGcsPath}playlist.m3u8`;

    // List only the .ts files from the 'hd/' directory
    const hdSegmentFiles = await listSegmentFilesForTranscode(hdFolderGcsPath);
    if (!hdSegmentFiles.length) {
      throw new Error('No HD segment files (.ts) were found in the output folder.');
    }

    // Generate signed URLs, mapping the simple filename to the full signed URL
    const segmentSignedUrls = new Map();
    await Promise.all(
      hdSegmentFiles.map(async (fullGcsPath) => {
        const fileName = fullGcsPath.split('/').pop();
        const signedUrl = await getSignedUrl(fullGcsPath, 7 * 24 * 60 * 60); // 7-day expiration
        segmentSignedUrls.set(fileName, signedUrl);
      })
    );

    // Update the HD playlist with the full signed segment URLs
    let playlistText = await downloadFromGCS(hdPlaylistGcsPath);
    const updatedPlaylistLines = playlistText.split('\n').map(line => {
      // If a line is a segment filename we've signed, replace it with its full URL
      return segmentSignedUrls.get(line.trim()) || line;
    });
    await uploadTextToGCS(hdPlaylistGcsPath, updatedPlaylistLines.join('\n'), 'application/x-mpegURL');
    console.log(`[transcodeMp4ToHls] HD playlist updated with signed segment URLs.`);

    // Generate a final signed URL for the now-updated HD playlist
    const signedPlaylistUrl = await getSignedUrl(hdPlaylistGcsPath, 7 * 24 * 60 * 60);

    // Step 5: Update Episode Subtitles with the HD Playlist URL
    const subtitleEntry = {
      language,
      gcsPath: hdPlaylistGcsPath, // The path to the HD playlist
      videoUrl: signedPlaylistUrl,  // The playable, signed URL for the HD playlist
    };
    episode.subtitles = [subtitleEntry];
    await episode.save();
    console.log(`[transcodeMp4ToHls] Episode ${episode.id} updated successfully.`);

    // Step 6: Return Response
    res.json({
      message: 'Transcoding and episode creation successful.',
      episodeId: episode.id,
      hlsPlaylistGcsPath: hdPlaylistGcsPath,
      signedPlaylistUrl,
    });

  } catch (error) {
    console.error('[transcodeMp4ToHls] A critical error occurred:', error);
    // Step 7: Delete episode on any failure
    if (episode) {
      await episode.destroy();
      console.log(`[transcodeMp4ToHls] Deleted episode ${episode.id} due to processing error.`);
    }
    res.status(500).json({ error: error.message || 'Failed to process video.' });
  }
};