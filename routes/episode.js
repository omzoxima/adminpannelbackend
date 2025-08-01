const express = require('express');
const router = express.Router();
const episodeController = require('../controllers/episodeController');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

router.post('/generate-language-upload-urls', episodeController.generateLanguageVideoUploadUrls);
router.post('/transcode-hls', episodeController.transcodeMp4ToHls);
router.post('/test-orientation', episodeController.testVideoOrientation);
router.post('/delete', episodeController.deleteEpisode);
router.post('/update', episodeController.updateEpisode);

module.exports = router; 