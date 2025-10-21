import { getTestDatabase } from './test-database.js';
import { testData } from '../fixtures/test-data.js';

let seededData = null;

export async function seedTestData() {
  if (seededData) {
    return seededData;
  }

  console.log('Seeding test data...');
  
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
    console.log(`Created ${organisations.length} test organisations`);
    
    // Seed users
    const users = await User.bulkCreate(testData.users);
    console.log(`Created ${users.length} test users`);
    
    // Seed phone numbers
    const phoneNumbers = await PhoneNumber.bulkCreate(testData.phoneNumbers);
    console.log(`Created ${phoneNumbers.length} test phone numbers`);
    
    // Seed phone registrations
    const phoneRegistrations = await PhoneRegistration.bulkCreate(testData.phoneRegistrations);
    console.log(`Created ${phoneRegistrations.length} test phone registrations`);
    
    seededData = {
      organisations,
      users,
      phoneNumbers,
      phoneRegistrations
    };
    
    console.log('Test data seeded successfully');
    return seededData;
    
  } catch (error) {
    console.error('Failed to seed test data:', error);
    throw error;
  }
}

export async function cleanupTestData() {
  console.log('Cleaning up test data...');
  
  try {
    const { PhoneRegistration, PhoneNumber, User, Organisation } = await import('../../lib/database.js');
    
    // Clean up in reverse order of dependencies
    await PhoneRegistration.destroy({ where: {}, force: true });
    await PhoneNumber.destroy({ where: {}, force: true });
    await User.destroy({ where: {}, force: true });
    await Organisation.destroy({ where: {}, force: true });
    
    seededData = null;
    console.log('Test data cleaned up successfully');
    
  } catch (error) {
    console.error('Failed to cleanup test data:', error);
    throw error;
  }
}

export function getSeededData() {
  return seededData;
}
