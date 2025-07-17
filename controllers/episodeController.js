import models from '../models/index.js';
import { listSegmentFiles, getSignedUrl, downloadFromGCS, uploadTextToGCS, uploadHLSFolderToGCS } from '../services/gcsStorage.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import convertToHLS from '../utils/convertToHLS.js';

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