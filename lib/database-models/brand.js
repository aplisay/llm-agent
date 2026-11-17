import { Model, DataTypes } from 'sequelize';

class Brand extends Model {}

/** A brand and its defaults for a new organisation (lib/brands.js). */
export function initBrand(sequelize, types = DataTypes) {
  Brand.init({
    id: { type: types.STRING(32), primaryKey: true },
    name: { type: types.STRING(120), allowNull: true },
    defaultCapabilities: { type: types.JSONB, allowNull: false, defaultValue: [] },
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'Brand',
    tableName: 'brands',
  });
  return Brand;
}

export { Brand };
