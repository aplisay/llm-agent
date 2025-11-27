import { getTestDatabase } from './test-database.js';
import { testData } from '../fixtures/test-data.js';

let seededData = null;

export async function seedTestData() {
  if (seededData) {
    return seededData;
  }

  
  const sequelize = await getTestDatabase();
  
  try {
    // Import models (we'll need to create a test version of the database module)
    const { Organisation, User, PhoneNumber, PhoneRegistration } = await import('../../lib/database.js');
    
    // Clear existing data
    await PhoneRegistration.destroy({ where: {}, force: true });
    await PhoneNumber.destroy({ where: {}, force: true });
    await User.destroy({ where: {}, force: true });
    await Organisation.destroy({ where: {}, force: true });
    
    // Seed organisations
    const organisations = await Organisation.bulkCreate(testData.organisations);
    
    // Seed users
    const users = await User.bulkCreate(testData.users);
    
    // Seed phone numbers
    const phoneNumbers = await PhoneNumber.bulkCreate(testData.phoneNumbers);
    
    // Seed phone registrations
    const phoneRegistrations = await PhoneRegistration.bulkCreate(testData.phoneRegistrations);
    
    seededData = {
      organisations,
      users,
      phoneNumbers,
      phoneRegistrations
    };
    
    return seededData;
    
  } catch (error) {
    throw error;
  }
}

export async function cleanupTestData() {
  
  try {
    const { PhoneRegistration, PhoneNumber, User, Organisation } = await import('../../lib/database.js');
    
    // Clean up in reverse order of dependencies
    await PhoneRegistration.destroy({ where: {}, force: true });
    await PhoneNumber.destroy({ where: {}, force: true });
    await User.destroy({ where: {}, force: true });
    await Organisation.destroy({ where: {}, force: true });
    
    seededData = null;
    
  } catch (error) {
    throw error;
  }
}

export function getSeededData() {
  return seededData;
}
