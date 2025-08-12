import express from 'express';
import { getAllSeries, getSeriesById, createSeries, updateSeriesStatus, updateSeries } from '../controllers/seriesController.js';
import multer from 'multer';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

router.get('/', getAllSeries);
router.get('/:id', getSeriesById);
router.post('/create', upload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'carousel_image', maxCount: 1 }
]), createSeries);
router.put('/update', upload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'carousel_image', maxCount: 1 }
]), updateSeries);
router.post('/update-status', updateSeriesStatus);

export default router; 