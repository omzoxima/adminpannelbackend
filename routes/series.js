import express from 'express';
import { getAllSeries, getSeriesById, createSeries, updateSeriesStatus } from '../controllers/seriesController.js';
import multer from 'multer';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

router.get('/', getAllSeries);
router.get('/:id', getSeriesById);
router.post('/create', upload.single('thumbnail'), createSeries);
router.post('/update-status', updateSeriesStatus);

export default router; 