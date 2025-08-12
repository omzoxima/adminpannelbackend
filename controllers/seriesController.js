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
      attributes: ['id', 'title', 'thumbnail_url', 'created_at', 'updated_at', 'is_popular','status']
    });
    // Generate fresh signed URLs for thumbnails and carousel images
    const seriesWithSignedUrls = await Promise.all(series.map(async s => ({
      id: s.id,
      title: s.title,
      status: s.status,
      is_popular: s.is_popular,
      thumbnail_url: s.thumbnail_url ? await getSignedUrl(s.thumbnail_url) : null,
      carousel_image_url: s.carousel_image_url ? await getSignedUrl(s.carousel_image_url) : null,
      created_at: s.created_at,
      updated_at: s.updated_at,
      category_name: s.Category ? s.Category.name : null
    })));
    res.json(seriesWithSignedUrls);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch series' });
  }
};

export const getSeriesById = async (req, res) => {
  try {
    const series = await Series.findByPk(req.params.id, {
      include: [
        { model: Category, attributes: ['name'] },
        { model: Episode, attributes: ['id','title', 'episode_number', 'description'], order: [['episode_number', 'ASC']] }
      ],
      attributes: ['id', 'title', 'thumbnail_url', 'carousel_image_url', 'created_at', 'updated_at', 'is_popular','status']
    });
    if (!series) return res.status(404).json({ error: 'Series not found' });
    // Generate fresh signed URLs for thumbnail and carousel image
    const signedThumbnailUrl = series.thumbnail_url ? await getSignedUrl(series.thumbnail_url) : null;
    const signedCarouselUrl = series.carousel_image_url ? await getSignedUrl(series.carousel_image_url) : null;
    res.json({
      id: series.id,
      title: series.title,
      thumbnail_url: signedThumbnailUrl,
      carousel_image_url: signedCarouselUrl,
      created_at: series.created_at,
      updated_at: series.updated_at,
      is_popular: series.is_popular,
      status: series.status,
      category_name: series.Category ? series.Category.name : null,
      episodes: series.Episodes ? series.Episodes.map(e => ({
        id: e.id,
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
    const { title, category_id, is_popular } = req.body;
    if (!title || !category_id || typeof is_popular === 'undefined' || !req.files.thumbnail) {
      return res.status(400).json({ error: 'Title, category_id, is_popular, and thumbnail file are required' });
    }
    
    let thumbnail_gcs_path = null;
    let carousel_image_gcs_path = null;
    
    // Handle thumbnail upload
    const thumbnailFile = req.files.thumbnail[0];
    const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (imageTypes.includes(thumbnailFile.mimetype)) {
      // For images, upload and store the GCS path
      thumbnail_gcs_path = await uploadToGCS(thumbnailFile, 'thumbnails');
    } else {
      const hlsId = uuidv4();
      const hlsDir = path.join('/tmp', hlsId);
      await fs.mkdir(hlsDir, { recursive: true });
      try {
        await convertToHLS(thumbnailFile.buffer, hlsDir);
        const gcsFolder = `thumbnails/${hlsId}/`;
        await uploadHLSFolderToGCS(hlsDir, gcsFolder);
        const playlistPath = `${gcsFolder}playlist.m3u8`;
        thumbnail_gcs_path = playlistPath;
      } catch (error) {
        console.error('Error processing thumbnail:', error);
        throw error;
      } finally {
        await fs.rm(hlsDir, { recursive: true, force: true }).catch(e => console.error('Cleanup error:', e));
      }
    }
    
    // Handle carousel image upload if provided
    if (req.files.carousel_image && req.files.carousel_image[0]) {
      const carouselFile = req.files.carousel_image[0];
      if (imageTypes.includes(carouselFile.mimetype)) {
        carousel_image_gcs_path = await uploadToGCS(carouselFile, 'carousel_images');
      } else {
        return res.status(400).json({ error: 'Carousel image must be an image file (JPEG, PNG, GIF, WebP)' });
      }
    }
    
    const newSeries = await Series.create({
      title,
      category_id,
      thumbnail_url: thumbnail_gcs_path,
      carousel_image_url: carousel_image_gcs_path,
      is_popular: is_popular === true || is_popular === 'true',
      status: 'Draft'
    });
    
    // Generate signed URLs for response
    const signedThumbnailUrl = thumbnail_gcs_path ? await getSignedUrl(thumbnail_gcs_path) : null;
    const signedCarouselUrl = carousel_image_gcs_path ? await getSignedUrl(carousel_image_gcs_path) : null;
    
    res.status(201).json({
      uuid: newSeries.id,
      title: newSeries.title,
      thumbnail_url: signedThumbnailUrl,
      carousel_image_url: signedCarouselUrl,
      is_popular: newSeries.is_popular,
      status: newSeries.status
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create series' });
  }
};

export const updateSeriesStatus = async (req, res) => {
  try {
    const { id, status } = req.body;
    if (!id || !status) {
      return res.status(400).json({ error: 'Series id and status are required' });
    }
    // Optionally, validate status value
    const allowedStatuses = ['Draft', 'Active', 'Inactive'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    const series = await Series.findByPk(id);
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    series.status = status;
    series.updated_at = new Date();
    await series.save();
    res.json({
      message: 'Series status updated successfully',
      id: series.id,
      status: series.status,
      updated_at: series.updated_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update series status' });
  }
};

export const updateSeries = async (req, res) => {
  try {
    const { id, title, category_id, is_popular } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Series id is required' });
    }
    
    const series = await Series.findByPk(id);
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    
    let thumbnail_gcs_path = series.thumbnail_url;
    let carousel_image_gcs_path = series.carousel_image_url;
    
    // Handle thumbnail update if provided
    if (req.files.thumbnail && req.files.thumbnail[0]) {
      const thumbnailFile = req.files.thumbnail[0];
      const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (imageTypes.includes(thumbnailFile.mimetype)) {
        thumbnail_gcs_path = await uploadToGCS(thumbnailFile, 'thumbnails');
      } else {
        return res.status(400).json({ error: 'Thumbnail must be an image file (JPEG, PNG, GIF, WebP)' });
      }
    }
    
    // Handle carousel image update if provided
    if (req.files.carousel_image && req.files.carousel_image[0]) {
      const carouselFile = req.files.carousel_image[0];
      const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (imageTypes.includes(carouselFile.mimetype)) {
        carousel_image_gcs_path = await uploadToGCS(carouselFile, 'carousel_images');
      } else {
        return res.status(400).json({ error: 'Carousel image must be an image file (JPEG, PNG, GIF, WebP)' });
      }
    }
    
    // Update series fields
    if (title) series.title = title;
    if (category_id) series.category_id = category_id;
    if (typeof is_popular !== 'undefined') series.is_popular = is_popular === true || is_popular === 'true';
    series.thumbnail_url = thumbnail_gcs_path;
    series.carousel_image_url = carousel_image_gcs_path;
    series.updated_at = new Date();
    
    await series.save();
    
    // Generate signed URLs for response
    const signedThumbnailUrl = thumbnail_gcs_path ? await getSignedUrl(thumbnail_gcs_path) : null;
    const signedCarouselUrl = carousel_image_gcs_path ? await getSignedUrl(carousel_image_gcs_path) : null;
    
    res.json({
      message: 'Series updated successfully',
      id: series.id,
      title: series.title,
      thumbnail_url: signedThumbnailUrl,
      carousel_image_url: signedCarouselUrl,
      is_popular: series.is_popular,
      status: series.status,
      updated_at: series.updated_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update series' });
  }
}; 