import { Sequelize } from 'sequelize';
import config from '../config/db.js';
import Category from './category.js';
import Series from './series.js';
import Episode from './episode.js';
import User from './user.js';


const sequelize = new Sequelize(
  config.DB_NAME,
  config.DB_USER,
  config.DB_PASSWORD,
  {
    host: config.DB_HOST,
    port: config.DB_PORT,
    dialect: 'postgres', // Explicitly set the dialect here
    dialectOptions: config.DB_DIALECT_OPTIONS || {}, // Ensure this is an object
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    logging: false,
  }
);

const models = {
  Category: Category(sequelize),
  Series: Series(sequelize),
  Episode: Episode(sequelize),
  User: User(sequelize)
};

models.Category.hasMany(models.Series, { foreignKey: 'category_id' });
models.Series.belongsTo(models.Category, { foreignKey: 'category_id' });
models.Series.hasMany(models.Episode, { foreignKey: 'series_id' });
models.Episode.belongsTo(models.Series, { foreignKey: 'series_id' });

export { sequelize };
export default models; 