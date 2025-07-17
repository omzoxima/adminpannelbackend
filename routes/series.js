const express = require('express');
const router = express.Router();
const seriesController = require('../controllers/seriesController');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

router.get('/', seriesController.getAllSeries);
router.get('/:id', seriesController.getSeriesById);
router.post('/create', upload.single('thumbnail'), seriesController.createSeries);

module.exports = router; 