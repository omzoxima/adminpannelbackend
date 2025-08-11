import express from 'express';
import { getAllCategories, createCategory } from '../controllers/categoryController.js';

const router = express.Router();

router.get('/', getAllCategories);
router.post('/create', createCategory);

export default router; 