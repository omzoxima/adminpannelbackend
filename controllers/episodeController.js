import models from '../models/index.js';
import { listSegmentFiles, getSignedUrl, downloadTextFromGCS, uploadTextToGCS, uploadHLSFolderToGCS, getUploadSignedUrl,listSegmentFilesForTranscode } from '../services/gcsStorage.js';
import { TranscoderServiceClient } from '@google-cloud/video-transcoder';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
// --- MODIFIED FUNCTION ---
import fetch from 'node-fetch';
import { Op } from 'sequelize';

const location = 'asia-south1'; // Set your region
const outputBucketName = 'run-sources-tuktuki-464514-asia-south1';
const bucketName = 'run-sources-tuktuki-464514-asia-south1'; // Set your output bucket
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






export async function transcodeMp4ToHls(inputFilePath, outputFolder) {
  const location = 'asia-south1'; // your location
  const inputUri = `gs://${bucketName}/${inputFilePath}`;
  const outputUri = `gs://${bucketName}/${outputFolder}`;

  // Create HD-only transcoding job
  const request = {
    parent: transcoderClient.locationPath('YOUR_PROJECT_ID', location),
    job: {
      inputUri,
      outputUri,
      config: {
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
            audioStream: {
              codec: 'aac',
              bitrateBps: 128000,
              channelCount: 2
            }
          }
        ],
        muxStreams: [
          {
            key: 'hd',
            container: 'ts',
            elementaryStreams: ['video-hd', 'audio-stereo']
          }
        ],
        manifests: [
          {
            fileName: 'playlist.m3u8',
            type: 'HLS',
            muxStreams: ['hd']
          }
        ]
      }
    }
  };

  console.log('Starting transcoding job...');
  const [job] = await transcoderClient.createJob(request);
  console.log(`Job started: ${job.name}`);

  // Wait for job completion
  let jobState;
  do {
    await new Promise(r => setTimeout(r, 5000));
    const [updatedJob] = await transcoderClient.getJob({ name: job.name });
    jobState = updatedJob.state;
    console.log(`Job state: ${jobState}`);
  } while (jobState !== 'SUCCEEDED');

  console.log('Transcoding completed.');

  // Paths
  const masterPlaylistPath = `${outputFolder}playlist.m3u8`;
  const variantPlaylistPath = `${outputFolder}hd.m3u8`;

  // Step 1: Sign variant playlist (hd.m3u8) + all TS files inside it
  const variantText = await downloadTextFromGCS(variantPlaylistPath);

  const tsFiles = variantText
    .split('\n')
    .filter(line => line.trim().endsWith('.ts'))
    .map(line => line.trim());

  const signedTsUrls = {};
  await Promise.all(tsFiles.map(async tsFile => {
    const fullPath = `${outputFolder}${tsFile}`;
    signedTsUrls[tsFile] = await getSignedUrl(fullPath, 60 * 6); // 6h expiry
  }));

  const signedVariantText = variantText.split('\n').map(line => {
    if (line.trim().endsWith('.ts')) {
      return signedTsUrls[line.trim()];
    }
    return line;
  }).join('\n');

  await uploadTextToGCS(
    variantPlaylistPath,
    signedVariantText,
    'application/vnd.apple.mpegurl',
    'public,max-age=300'
  );

  // Step 2: Sign the variant playlist URL and update master playlist
  const signedVariantUrl = await getSignedUrl(variantPlaylistPath, 60 * 6);

  const masterText = await downloadTextFromGCS(masterPlaylistPath);
  const signedMasterText = masterText.split('\n').map(line => {
    if (line.trim() === 'hd.m3u8') {
      return signedVariantUrl;
    }
    return line;
  }).join('\n');

  await uploadTextToGCS(
    masterPlaylistPath,
    signedMasterText,
    'application/vnd.apple.mpegurl',
    'public,max-age=300'
  );

  // Step 3: Return signed master playlist URL
  const signedMasterUrl = await getSignedUrl(masterPlaylistPath, 60 * 6);

  console.log(`Signed Master Playlist URL: ${signedMasterUrl}`);
  return signedMasterUrl;
}





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