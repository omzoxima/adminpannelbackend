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
  const bucketName = pathParts[0];
  const fileName = pathParts.slice(1).join('/');
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


// Define the transcodeMp4ToHls function as an exportable constant
export const transcodeMp4ToHls = async (req, res) => {
  console.log(`[transcodeMp4ToHls] Received request to /transcode-hls`);
  const { gcsFilePath } = req.body;

  if (!gcsFilePath) {
    console.error('[transcodeMp4ToHls] Error: Missing gcsFilePath in request body.');
    return res.status(400).json({ error: 'Missing gcsFilePath in request body.' });
  }

  if (!isValidGcsUri(gcsFilePath)) {
    console.error(`[transcodeMp4ToHls] Error: Invalid GCS file path format: ${gcsFilePath}`);
    return res.status(400).json({ error: 'Invalid GCS file path format. Must start with gs://' });
  }

  // Generate a unique output folder for this transcoding job
  const uniqueOutputFolder = `hls_output/${uuidv4()}/`;
  const outputBaseUri = `gs://${outputBucketName}/${uniqueOutputFolder}`;
  console.log(`[transcodeMp4ToHls] Input GCS Path: ${gcsFilePath}`);
  console.log(`[transcodeMp4ToHls] Generated Output Base URI: ${outputBaseUri}`);

  try {
    // Get the project ID from the authenticated client
    const projectId = await transcoderClient.getProjectId();
    console.log(`[transcodeMp4ToHls] Using Project ID: ${projectId}`);

    const job = {
      inputUri: gcsFilePath,
      outputUri: outputBaseUri,
      config: {
        elementaryStreams: [
          {
            key: 'video-sd',
            videoStream: {
              codec: 'h264',
              h264: {
                heightPixels: 360,
                widthPixels: 640,
                bitrateBps: 800000,
                frameRate: 30,
              },
            },
          },
          {
            key: 'video-hd',
            videoStream: {
              codec: 'h264',
              h264: {
                heightPixels: 720,
                widthPixels: 1280,
                bitrateBps: 2500000,
                frameRate: 30,
              },
            },
          },
          {
            key: 'audio-stereo',
            audioStream: { codec: 'aac', bitrateBps: 128000, channelCount: 2 },
          },
        ],
        muxStreams: [
          { key: 'sd', container: 'ts', elementaryStreams: ['video-sd', 'audio-stereo'] },
          { key: 'hd', container: 'ts', elementaryStreams: ['video-hd', 'audio-stereo'] },
        ],
        manifests: [
          { fileName: 'playlist.m3u8', type: 'HLS', muxStreams: ['sd', 'hd'] },
        ],
      },
    };

    const request = {
      parent: `projects/${projectId}/locations/${location}`,
      job: job,
    };

    console.log(`[transcodeMp4ToHls] Sending job request to Transcoder API:`);
    console.log(JSON.stringify(request, null, 2));

    const [operation] = await transcoderClient.createJob(request);
    const jobName = operation.name;
    console.log(`[transcodeMp4ToHls] Transcoder job created: ${jobName}`);

    // --- IMPORTANT: For a production API, you would typically NOT wait here. ---
    // Instead, you'd respond immediately with the jobId and rely on Pub/Sub
    // notifications from Transcoder API to update your system when the job completes.
    // This waiting loop is for demonstration purposes to show the full flow in one request.
    let jobState = 'PENDING';
    let jobResult;
    const startTime = Date.now();
    const timeout = 10 * 60 * 1000; // 10 minutes timeout for the job to complete

    while (jobState !== 'SUCCEEDED' && jobState !== 'FAILED' && (Date.now() - startTime < timeout)) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds
      const [jobStatus] = await transcoderClient.getJob({ name: jobName });
      jobState = jobStatus.state;
      jobResult = jobStatus;
      console.log(`[transcodeMp4ToHls] Job ${jobName} status: ${jobState}`);
    }

    if (jobState === 'SUCCEEDED') {
      console.log('[transcodeMp4ToHls] Transcoding job completed successfully!');
      const hlsPlaylistGcsPath = `${outputBaseUri}playlist.m3u8`;
      const signedPlaylistUrl = await getSignedUrlForGcs(hlsPlaylistGcsPath);
      const sampleSegmentFileName = `${uniqueOutputFolder}segment_00000.ts`;
      const sampleSegmentGcsPath = `gs://${outputBucketName}/${sampleSegmentFileName}`;
      const signedSampleSegmentUrl = await getSignedUrlForGcs(sampleSegmentGcsPath);
      res.json({
        message: 'Transcoding job initiated and completed successfully (for demonstration).',
        hlsPlaylistGcsPath,
        signedPlaylistUrl,
        signedSampleSegmentUrl,
      });
    } else if (jobState === 'FAILED') {
      console.error('[transcodeMp4ToHls] Transcoding job failed.');
      console.error('[transcodeMp4ToHls] Error details:', jobResult.error);
      res.status(500).json({ error: `Transcoding job failed: ${jobResult.error ? jobResult.error.message : 'Unknown error'}` });
    } else {
      console.warn('[transcodeMp4ToHls] Transcoding job timed out or did not complete in time.');
      res.status(500).json({ error: 'Transcoding job did not complete within the allowed time.' });
    }
  } catch (error) {
    console.error('[transcodeMp4ToHls] API Error during transcoding process:', error);
    res.status(500).json({ error: error.message || 'Failed to initiate HLS transcoding.' });
  }
};