import models from '../models/index.js';
const { Category } = models;

export const getAllCategories = async (req, res) => {
  try {
    const categories = await Category.findAll({
      attributes: ['id', 'name', 'description', 'created_at', 'updated_at']
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch categories' });
  }
};

export const createCategory = async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const newCategory = await Category.create({ name, description });
    res.status(201).json({ uuid: newCategory.id, name: newCategory.name });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create category' });
  }
}; 