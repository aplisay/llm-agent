export const testData = {
  organisations: [
    {
      id: 'test-org-1',
      name: 'Test Organisation 1',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    },
    {
      id: 'test-org-2', 
      name: 'Test Organisation 2',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    },
    {
      id: 'test-org-3',
      name: 'Test Organisation 3',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    }
  ],

  users: [
    {
      id: 'test-user-1',
      organisationId: 'test-org-1',
      name: 'Test User 1',
      email: 'user1@test.com',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    },
    {
      id: 'test-user-2',
      organisationId: 'test-org-2', 
      name: 'Test User 2',
      email: 'user2@test.com',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    },
    {
      id: 'test-user-3',
      organisationId: 'test-org-3',
      name: 'Test User 3', 
      email: 'user3@test.com',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    }
  ],

  phoneNumbers: [
    {
      number: '+1234567890',
      organisationId: 'test-org-1',
      handler: 'livekit',
      outbound: true,
      name: 'Test Phone 1',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    },
    {
      number: '+0987654321',
      organisationId: 'test-org-1',
      handler: 'jambonz',
      outbound: false,
      name: 'Test Phone 2',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    },
    {
      number: '+1122334455',
      organisationId: 'test-org-2',
      handler: 'livekit',
      outbound: true,
      name: 'Test Phone 3',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    },
    {
      number: '+5566778899',
      organisationId: 'test-org-2',
      handler: 'jambonz',
      outbound: false,
      name: 'Test Phone 4',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    }
  ],

  phoneRegistrations: [
    {
      id: 'reg-1',
      organisationId: 'test-org-1',
      name: 'Test Registration 1',
      registrar: 'sip:test1.example.com:5060',
      username: 'testuser1',
      password: 'testpass1',
      handler: 'livekit',
      outbound: true,
      options: { region: 'us-east' },
      status: 'active',
      state: 'registered',
      error: null,
      lastSeenAt: new Date('2024-01-01T12:00:00Z'),
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    },
    {
      id: 'reg-2',
      organisationId: 'test-org-1',
      name: 'Test Registration 2',
      registrar: 'sip:test2.example.com:5060',
      username: 'testuser2',
      password: 'testpass2',
      handler: 'jambonz',
      outbound: false,
      options: { region: 'us-west' },
      status: 'disabled',
      state: 'initial',
      error: null,
      lastSeenAt: null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    },
    {
      id: 'reg-3',
      organisationId: 'test-org-2',
      name: 'Test Registration 3',
      registrar: 'sip:test3.example.com:5060',
      username: 'testuser3',
      password: 'testpass3',
      handler: 'livekit',
      outbound: true,
      options: { region: 'eu-west' },
      status: 'failed',
      state: 'failed',
      error: 'Registration timeout',
      lastSeenAt: new Date('2024-01-01T10:00:00Z'),
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    },
    {
      id: 'reg-4',
      organisationId: 'test-org-3',
      name: 'Test Registration 4',
      registrar: 'sip:test4.example.com:5060',
      username: 'testuser4',
      password: 'testpass4',
      handler: 'jambonz',
      outbound: false,
      options: { region: 'ap-southeast' },
      status: 'active',
      state: 'registering',
      error: null,
      lastSeenAt: null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z')
    }
  ]
};

export const testAuth = {
  validUsers: [
    { id: 'test-user-1', organisationId: 'test-org-1' },
    { id: 'test-user-2', organisationId: 'test-org-2' },
    { id: 'test-user-3', organisationId: 'test-org-3' }
  ],
  invalidUsers: [
    { id: 'invalid-user', organisationId: 'invalid-org' },
    { id: 'test-user-1', organisationId: 'test-org-2' } // Wrong org
  ]
};

export const testEndpoints = {
  validE164Numbers: ['+1234567890', '+0987654321', '+1122334455', '+5566778899'],
  invalidE164Numbers: ['1234567890', 'invalid', '+123', '123-456-7890'],
  validSipUris: [
    'sip:user@domain.com:5060',
    'sip:domain.com:5060',
    'sip:user@domain.com',
    'sip:domain.com'
  ],
  invalidSipUris: [
    'http://domain.com',
    'sip:',
    'invalid',
    'sip:user@',
    'sip:@domain.com'
  ],
  validHandlers: ['livekit', 'jambonz'],
  invalidHandlers: ['invalid', 'sip', ''],
  validStatuses: ['active', 'failed', 'disabled'],
  validStates: ['initial', 'registering', 'registered', 'failed']
};
