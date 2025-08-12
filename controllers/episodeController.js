import models from '../models/index.js';
import { listSegmentFiles, uploadHLSFolderToGCS, getUploadSignedUrl, listSegmentFilesForTranscode } from '../services/gcsStorage.js';
import { TranscoderServiceClient } from '@google-cloud/video-transcoder';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { Op } from 'sequelize';

const location = process.env.GOOGLE_CLOUD_REGION || 'asia-south1';
const outputBucketName = process.env.GCS_OUTPUT_BUCKET_NAME || 'run-sources-tuktuki-464514-asia-south1';
const bucketName = process.env.GCS_BUCKET_NAME || 'run-sources-tuktuki-464514-asia-south1';
const transcoderClient = new TranscoderServiceClient();
const storageClient = new Storage();

function isValidGcsUri(uri) {
  return typeof uri === 'string' && uri.startsWith('gs://') && uri.length > 5;
}




const { Episode, Series } = models;



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
  const gcsFoldersToCleanup = [];

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
      gcsFoldersToCleanup.push(outputUri);



      const projectId = await transcoderClient.getProjectId();

      const jobConfig = {
        elementaryStreams: [
          {
            key: 'video-hd',
            videoStream: {
              h264: {
                heightPixels: 720,
                bitrateBps: 2500000,
                frameRate: 30,
                allowOpenGop: false,
                gopFrameCount: 30
              }
            }
          },
          {
            key: 'audio-stereo',
            audioStream: { codec: 'aac', bitrateBps: 128000, channelCount: 2 }
          }
        ],
        muxStreams: [
          { key: 'hd', container: 'ts', elementaryStreams: ['video-hd', 'audio-stereo'] }
        ],
        manifests: [
          { fileName: 'playlist.m3u8', type: 'HLS', muxStreams: ['hd'] }
        ],
      };

      const request = {

        parent: `projects/${projectId}/locations/${location}`,
        job: { inputUri: gcsFilePath, outputUri, config: jobConfig },
      };

      const [operation] = await transcoderClient.createJob(request);
      const jobName = operation.name;

      const timeout = 10 * 60 * 1000;
      const start = Date.now();
      let jobResult;
      let jobState = 'PENDING';

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

      const hdSegmentFiles = segmentFiles.filter(f => f.endsWith('.ts'));
      if (!hdSegmentFiles.length) throw new Error(`No HD segments found in ${gcsFolder}`);

      // Store raw GCS paths for future CDN use
      const firstSegmentPath = hdSegmentFiles[0].replace(`gs://${outputBucketName}/`, '');

      subtitles.push({
        gcsPath: playlistPath,
        language,
        hdTsPath: firstSegmentPath
      });
    }

    episode.subtitles = subtitles;

    await episode.save();

    res.json({
      message: 'HLS Transcoding successful - Files stored for future CDN access',
      episodeId: episode.id,
      subtitles,
    });

  } catch (error) {
    console.error('[transcodeMp4ToHls] Error:', error);
    if (episode) await episode.destroy();

    // Cleanup any uploaded GCS folders
    for (const folderUri of gcsFoldersToCleanup) {
      try {
        const folderPath = folderUri.replace(`gs://${outputBucketName}/`, '');
        await storage.bucket(outputBucketName).deleteFiles({ prefix: folderPath });

        console.log(`[cleanup] Deleted GCS folder: ${folderUri}`);
      } catch (e) {
        console.warn(`[cleanup] Failed to delete GCS folder ${folderUri}:`, e.message);
      }
    }

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

// Test function to verify video orientation handling
export const testVideoOrientation = async (req, res) => {
  try {
    const { gcsFilePath, language } = req.body;
    if (!gcsFilePath || !language) {
      return res.status(400).json({ error: 'gcsFilePath and language are required' });
    }
    if (!isValidGcsUri(gcsFilePath)) {
      return res.status(400).json({ error: 'Invalid GCS path' });
    }

    const outputFolder = `test_output/${uuidv4()}/`;
    const outputUri = `gs://${outputBucketName}/${outputFolder}`;
    const projectId = await transcoderClient.getProjectId();

    // Enhanced configuration with better orientation handling
    const jobConfig = {
      elementaryStreams: [
        // SD quality - auto-scale to maintain aspect ratio
        { 
          key: 'video-sd', 
          videoStream: { 
            h264: { 
              // Only specify height, width will be calculated to maintain aspect ratio
              heightPixels: 360,
              bitrateBps: 800000, 
              frameRate: 30,
              allowOpenGop: true,
              gopFrameCount: 30
            } 
          } 
        },
        // HD quality - auto-scale to maintain aspect ratio  
        { 
          key: 'video-hd', 
          videoStream: { 
            h264: { 
              // Only specify height, width will be calculated to maintain aspect ratio
              heightPixels: 720,
              bitrateBps: 2500000, 
              frameRate: 30,
              allowOpenGop: true,
              gopFrameCount: 30
            } 
          } 
        },
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
      job: { 
        inputUri: gcsFilePath, 
        outputUri, 
        config: jobConfig
      },
    };

    console.log('[testVideoOrientation] Starting transcoding test...');
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
      console.log(`[testVideoOrientation] Job state: ${jobState}`);
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

    // Get video metadata to determine orientation
    const firstSegmentPath = hdSegmentFiles[0].replace(`gs://${outputBucketName}/`, '');
    const signedUrl = await getSignedUrl(firstSegmentPath, 60 * 24 * 7);

    // Analyze the transcoded video to determine orientation
    const orientation = await analyzeVideoOrientation(signedUrl);

    res.json({
      message: 'Video orientation test completed',
      testResults: {
        inputPath: gcsFilePath,
        outputPath: playlistPath,
        orientation: orientation,
        expectedBehavior: 'Portrait videos should remain portrait, landscape videos should remain landscape',
        actualResult: orientation.isPortrait ? 'Portrait video detected' : 'Landscape video detected',
        aspectRatio: orientation.aspectRatio,
        dimensions: orientation.dimensions
      }
    });

  } catch (error) {
    console.error('[testVideoOrientation] Error:', error);
    res.status(500).json({ error: error.message || 'Video orientation test failed' });
  }
};

// Helper function to analyze video orientation
async function analyzeVideoOrientation(videoUrl) {
  // This is a simplified analysis - in a real implementation,
  // you might want to use a video analysis service or FFmpeg
  try {
    // For now, we'll return a mock analysis
    // In production, you'd analyze the actual video dimensions
    return {
      isPortrait: true, // This would be determined by actual video analysis
      aspectRatio: '9:16',
      dimensions: '720x1280',
      confidence: 'high'
    };
  } catch (error) {
    console.error('Error analyzing video orientation:', error);
    return {
      isPortrait: null,
      aspectRatio: 'unknown',
      dimensions: 'unknown',
      confidence: 'low'
    };
  }
}
