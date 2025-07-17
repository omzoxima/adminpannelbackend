import models from '../models/index.js';
import { uploadToGCS, uploadHLSFolderToGCS, getSignedUrl } from '../services/gcsStorage.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import convertToHLS from '../utils/convertToHLS.js';

const { Series, Category, Episode } = models;

export const getAllSeries = async (req, res) => {
  try {
    const series = await Series.findAll({
      include: [{ model: Category, attributes: ['name'] }],
      attributes: ['id', 'title', 'thumbnail_url', 'created_at', 'updated_at', 'is_popular']
    });
    res.json(series.map(s => ({
      id: s.id,
      title: s.title,
      is_popular: s.is_popular,
      thumbnail_url: s.thumbnail_url,
      created_at: s.created_at,
      updated_at: s.updated_at,
      category_name: s.Category ? s.Category.name : null
    })));
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch series' });
  }
};

export const getSeriesById = async (req, res) => {
  try {
    const series = await Series.findByPk(req.params.id, {
      include: [
        { model: Category, attributes: ['name'] },
        { model: Episode, attributes: ['title', 'episode_number', 'description'], order: [['episode_number', 'ASC']] }
      ],
      attributes: ['id', 'title', 'thumbnail_url', 'created_at', 'updated_at', 'is_popular']
    });
    if (!series) return res.status(404).json({ error: 'Series not found' });
    res.json({
      id: series.id,
      title: series.title,
      thumbnail_url: series.thumbnail_url,
      created_at: series.created_at,
      updated_at: series.updated_at,
      is_popular: series.is_popular,
      category_name: series.Category ? series.Category.name : null,
      episodes: series.Episodes ? series.Episodes.map(e => ({
        title: e.title,
        episode_number: e.episode_number,
        description: e.description
      })) : []
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch series details' });
  }
};

export const createSeries = async (req, res) => {
  try {
    const { title, category_id, is_checkbox } = req.body;
    if (!title || !category_id) {
      return res.status(400).json({ error: 'Title and category_id are required' });
    }
    let thumbnail_url = null;
    if (req.file) {
      console.log('check');
      const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (imageTypes.includes(req.file.mimetype)) {
        console.log('image type');
        const gcsPath = await uploadToGCS(req.file, 'thumbnails');
        thumbnail_url = await getSignedUrl(gcsPath);
      } else {
        const hlsId = uuidv4();
        const hlsDir = path.join('/tmp', hlsId);
        await fs.mkdir(hlsDir, { recursive: true });
        try {
          await convertToHLS(req.file.buffer, hlsDir);
          const gcsFolder = `thumbnails/${hlsId}/`;
          await uploadHLSFolderToGCS(hlsDir, gcsFolder);
          const playlistPath = `${gcsFolder}playlist.m3u8`;
          const signedUrl = await getSignedUrl(playlistPath);
          thumbnail_url = signedUrl;
        } catch (error) {
          console.error('Error processing thumbnail:', error);
          throw error;
        } finally {
          await fs.rm(hlsDir, { recursive: true, force: true }).catch(e => console.error('Cleanup error:', e));
        }
      }
    }
    const newSeries = await Series.create({
      title,
      category_id,
      thumbnail_url,
      is_checkbox: is_checkbox === true || is_checkbox === 'true'
    });
    res.status(201).json({
      uuid: newSeries.id,
      title: newSeries.title,
      thumbnail_url: thumbnail_url,
      is_checkbox: newSeries.is_popular
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create series' });
  }
}; 