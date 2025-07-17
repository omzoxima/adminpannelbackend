import models from '../models/index.js';
import jwt from 'jsonwebtoken';

const { User } = models;

export const login = async (req, res) => {
  const { phone_or_email, password } = req.body;
  if (!phone_or_email || !password) {
    return res.status(400).json({ error: 'phone_or_email and password are required' });
  }

  const user = await User.findOne({ where: { phone_or_email } });
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // You should use a password hash check here, but keeping your logic:
  const match = await User.findOne({ where: { password }});
  if (!match) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
  res.json({
    token,
    user: {
      id: user.id,
      role: user.role,
      phone_or_email: user.phone_or_email,
      Name: user.Name
    }
  });
};

export const getAdmins = async (req, res) => {
  try {
    const admins = await User.findAll({
      where: { role: 'admin' },
      attributes: ['id','role', 'phone_or_email', 'Name', 'created_at', 'updated_at']
    });
    res.json(admins);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch admin users' });
  }
};

export const profile = async (req, res) => {
  try {
    const admin = await User.findByPk(req.user.id);
    if (!admin) return res.status(404).json({ message: 'Admin not found' });
    res.json({ id: admin.id, email: admin.email, role: admin.role });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
}; 