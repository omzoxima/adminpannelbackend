import express from 'express';
import { 
  generateLanguageVideoUploadUrls, 
  transcodeMp4ToHls, 
  testVideoOrientation, 
  deleteEpisode, 
  updateEpisode
} from '../controllers/episodeController.js';
import multer from 'multer';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

router.post('/generate-language-upload-urls', generateLanguageVideoUploadUrls);
router.post('/transcode-hls', transcodeMp4ToHls);
router.post('/test-orientation', testVideoOrientation);
router.post('/delete', deleteEpisode);
router.post('/update', updateEpisode);


export default router; 