import { PhoneRegistration } from './database.js';

/**
 * Simulates phone registration lifecycle for testing purposes
 * This is a temporary simulation until a proper worker process is implemented
 */
class RegistrationSimulator {
  constructor() {
    this.activeSimulations = new Map();
  }

  /**
   * Start simulation for a phone registration
   * @param {string} registrationId - The ID of the registration to simulate
   */
  async startSimulation(registrationId) {
    // Clear any existing simulation for this registration
    this.stopSimulation(registrationId);

    const simulation = {
      registrationId,
      timeouts: [],
      startTime: Date.now()
    };

    this.activeSimulations.set(registrationId, simulation);

    try {
      // Step 1: Set status to active and state to initial
      await this.updateRegistration(registrationId, {
        status: 'active',
        state: 'initial'
      });

      // Step 2: After 3-60 seconds, state goes to registering
      const registeringDelay = this.getRandomDelay(3000, 60000);
      const registeringTimeout = setTimeout(async () => {
        await this.updateRegistration(registrationId, { state: 'registering' });
      }, registeringDelay);
      simulation.timeouts.push(registeringTimeout);

      // Step 3: After another 3-10 seconds, 75% registered, 25% failed
      const finalDelay = this.getRandomDelay(3000, 10000);
      const finalTimeout = setTimeout(async () => {
        const isSuccess = Math.random() < 0.75; // 75% success rate
        await this.updateRegistration(registrationId, { 
          state: isSuccess ? 'registered' : 'failed' 
        });

        // Step 4: After 120-240 seconds, 50% chance to flip state
        const flipDelay = this.getRandomDelay(120000, 240000);
        const flipTimeout = setTimeout(async () => {
          if (Math.random() < 0.5) { // 50% chance to flip
            const currentRecord = await PhoneRegistration.findByPk(registrationId);
            if (currentRecord) {
              const newState = currentRecord.state === 'registered' ? 'failed' : 'registered';
              await this.updateRegistration(registrationId, { state: newState });
            }
          }
        }, flipDelay);
        simulation.timeouts.push(flipTimeout);

        // Step 5: After 300 seconds total, if state is failed, set status to failed
        const statusCheckDelay = 300000 - finalDelay; // 300s total minus time already waited
        if (statusCheckDelay > 0) {
          const statusTimeout = setTimeout(async () => {
            const currentRecord = await PhoneRegistration.findByPk(registrationId);
            if (currentRecord && currentRecord.state === 'failed') {
              await this.updateRegistration(registrationId, { status: 'failed' });
            }
          }, statusCheckDelay);
          simulation.timeouts.push(statusTimeout);
        }
      }, finalDelay);
      simulation.timeouts.push(finalTimeout);

    } catch (error) {
      console.error('Error in registration simulation:', error);
      this.stopSimulation(registrationId);
    }
  }

  /**
   * Stop simulation for a registration
   * @param {string} registrationId - The ID of the registration
   */
  stopSimulation(registrationId) {
    const simulation = this.activeSimulations.get(registrationId);
    if (simulation) {
      // Clear all timeouts
      simulation.timeouts.forEach(timeout => clearTimeout(timeout));
      this.activeSimulations.delete(registrationId);
    }
  }

  /**
   * Update registration in database
   * @param {string} registrationId - The ID of the registration
   * @param {object} updates - Fields to update
   */
  async updateRegistration(registrationId, updates) {
    try {
      const registration = await PhoneRegistration.findByPk(registrationId);
      if (registration) {
        await registration.update(updates);
      }
    } catch (error) {
      console.error(`Error updating registration ${registrationId}:`, error);
    }
  }

  /**
   * Get random delay between min and max milliseconds
   * @param {number} min - Minimum delay in milliseconds
   * @param {number} max - Maximum delay in milliseconds
   * @returns {number} Random delay
   */
  getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Get simulation status for a registration
   * @param {string} registrationId - The ID of the registration
   * @returns {object|null} Simulation status or null if not found
   */
  getSimulationStatus(registrationId) {
    const simulation = this.activeSimulations.get(registrationId);
    if (!simulation) return null;

    return {
      registrationId,
      startTime: simulation.startTime,
      duration: Date.now() - simulation.startTime,
      activeTimeouts: simulation.timeouts.length
    };
  }

  /**
   * Get all active simulations
   * @returns {Array} Array of simulation statuses
   */
  getAllSimulations() {
    return Array.from(this.activeSimulations.values()).map(sim => ({
      registrationId: sim.registrationId,
      startTime: sim.startTime,
      duration: Date.now() - sim.startTime,
      activeTimeouts: sim.timeouts.length
    }));
  }
}

// Export singleton instance
export const registrationSimulator = new RegistrationSimulator();
