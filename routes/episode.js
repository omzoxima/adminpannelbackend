const express = require('express');
const router = express.Router();
const episodeController = require('../controllers/episodeController');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

router.get('/:id/hls-url', episodeController.getEpisodeHlsUrl);
router.post('/upload-multilingual', upload.fields([{ name: 'videos', maxCount: 10 }]), episodeController.uploadMultilingual);

module.exports = router; 