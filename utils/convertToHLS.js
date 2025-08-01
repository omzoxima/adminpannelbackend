const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs/promises');

// Configure FFmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Converts a video buffer to HLS format in the specified output directory.
 * Preserves original video orientation (portrait/landscape) and aspect ratio.
 * @param {Buffer} videoBuffer - The video file buffer.
 * @param {string} outputDir - The directory to output HLS files.
 * @returns {Promise<string>} - Resolves with the path to the generated playlist.m3u8 file.
 */
async function convertToHLS(videoBuffer, outputDir) {
  const tempInputPath = path.join(outputDir, 'input.mp4');
  await fs.writeFile(tempInputPath, videoBuffer);

  const hlsPlaylist = path.join(outputDir, 'playlist.m3u8');

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(tempInputPath)
      .inputOptions([
        '-re',
        '-analyzeduration 100M',
        '-probesize 100M'
      ])
      .outputOptions([
        '-c:v libx264',
        '-profile:v baseline',
        '-level 3.0',
        '-pix_fmt yuv420p',
        '-preset fast',
        '-crf 23',
        // Preserve original video orientation and aspect ratio
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // Ensure even dimensions for H.264 compatibility
        '-c:a aac',
        '-b:a 128k',
        '-start_number 0',
        '-hls_time 10',
        '-hls_list_size 0',
        '-hls_segment_filename', path.join(outputDir, 'segment_%03d.ts'),
        '-f hls'
      ])
      .output(hlsPlaylist)
      .on('end', () => resolve(hlsPlaylist))
      .on('error', (err) => reject(err))
      .run();
  });
}

module.exports = convertToHLS; 