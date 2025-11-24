// Mock for dotenv/config that actually loads environment variables
import dotenv from 'dotenv';
dotenv.config();
// Ensure stable test defaults
process.env.CREDENTIALS_KEY = process.env.CREDENTIALS_KEY || 'test-secret-key';
export default {}; 