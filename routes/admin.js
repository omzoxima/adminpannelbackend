import express from 'express';
import { login, getAdmins } from '../controllers/adminController.js';

const router = express.Router();

router.post('/login', login);
router.get('/admins', getAdmins);

export default router; 