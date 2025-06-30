const path  = require('path');
const admin = require('firebase-admin');
const mqtt  = require('mqtt');

const serviceAccount = require(path.join(
  __dirname,
  'guardianhive-8e3e0-firebase-adminsdk-fbsvc-ab9a2fc414.json'
));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://guardianhive-8e3e0-default-rtdb.europe-west1.firebasedatabase.app/' 
});

const db = admin.database();
console.log('Firebase Admin initialized with Realtime Database.');

const client = mqtt.connect('mqtt://www.andreicatanoiu.ro', {
  port:     1883,
  username: 'admin',
  password: 'admin',
});

const deviceCache = new Map();

client.on('connect', async () => {
  console.log('Connected to MQTT broker');
  
  try {
    const snapshot = await db.ref('devices').once('value');
    const devicesData = snapshot.val();
    
    if (devicesData) {
      Object.keys(devicesData).forEach(deviceId => {
        const data = devicesData[deviceId];
        deviceCache.set(deviceId, {
          status: data.status,
          lastUpdate: data.lastUpdate || 0,
          lastMessageTime: Date.now()
        });
      });
      console.log(`Loaded ${deviceCache.size} devices into cache`);
    } else {
      console.log('No devices found in database');
    }
  } catch (err) {
    console.error('Error loading device cache:', err);
  }
  
  client.subscribe('senzor/licenta/andrei/catanoiu/+/+', err => {
    if (err) console.error('MQTT subscribe error:', err);
    else     console.log('Subscribed to senzor/licenta/andrei/catanoiu/+/+');
  });
});
client.on('error', err => console.error('MQTT Error:', err));

async function logMessage(deviceId, type, payload) {
  const now = Date.now();
  const messageRef = db.ref('mqtt_messages').push();
  await messageRef.set({ 
    deviceId, 
    type, 
    payload, 
    timestamp: now 
  });
}

client.on('message', async (topic, payloadBuffer) => {
  const payload     = payloadBuffer.toString();
  const parts       = topic.split('/');
  const deviceId    = parts[4];
  const messageType = parts[5];
  const now         = Date.now();

  try {
    if (messageType === 'availability') {
      let newStatus;
      
      if (payload === 'alive') {
        newStatus = 'ONLINE';
      } else if (payload === 'maintenance') {
        newStatus = 'MAINTENANCE';
      } else {
        newStatus = 'ONLINE';
      }

      const cached = deviceCache.get(deviceId);
      const currentStatus = cached?.status;
      const lastMessageTime = cached?.lastMessageTime || 0;
      const timeSinceLastMessage = Date.now() - lastMessageTime;

      const statusChanged = currentStatus !== newStatus;
      const needsRevalidation = timeSinceLastMessage >= 2*60*1000;

      if (newStatus === 'MAINTENANCE' || statusChanged || needsRevalidation) {
        await logMessage(deviceId, 'availability', payload);
        
        await db.ref(`devices/${deviceId}`).update({ 
          status: newStatus, 
          lastUpdate: now 
        });

        console.log(`[availability:${newStatus}] updated for ${deviceId} (payload: ${payload}) - ${statusChanged ? 'changed' : newStatus === 'MAINTENANCE' ? 'forced maintenance' : 'revalidation'}`);
      } else {
        console.log(`[availability:${newStatus}] no update needed for ${deviceId} (payload: ${payload})`);
      }

      deviceCache.set(deviceId, {
        status: newStatus,
        lastUpdate: now,
        lastMessageTime: Date.now()
      });
    }
    
    else if (messageType === 'alive') {
      const status = 'ONLINE';
      const cached = deviceCache.get(deviceId);
      const currentStatus = cached?.status;
      const lastMessageTime = cached?.lastMessageTime || 0;
      const timeSinceLastMessage = Date.now() - lastMessageTime;

      const statusChanged = currentStatus !== status;
      const needsRevalidation = timeSinceLastMessage >= 2*60*1000;

      if (cached?.status === 'MAINTENANCE') {
        console.log(`[alive] dispozitiv ${deviceId} este în mentenanță, nu schimbăm statusul.`);
      } else if (statusChanged || needsRevalidation) {
        if (statusChanged) {
          await logMessage(deviceId, 'alive', payload);
        }
        await db.ref(`devices/${deviceId}`).update({ 
          status, 
          lastUpdate: now 
        });

        console.log(`[alive:${status}] updated for ${deviceId} (${statusChanged ? 'changed' : 'revalidation'})`);
      } else {
        console.log(`[alive:${status}] no update needed for ${deviceId}`);
      }

      deviceCache.set(deviceId, {
        status,
        lastUpdate: now,
        lastMessageTime: Date.now()
      });
    }

    else if (messageType === 'alerts') {
      const lastAlertSnapshot = await db.ref('mqtt_messages')
        .orderByChild('deviceId')
        .equalTo(deviceId)
        .limitToLast(50) 
        .once('value');
      
      let lastAlertTimestamp = 0;
      if (lastAlertSnapshot.val()) {
        const messages = lastAlertSnapshot.val();
        Object.values(messages).forEach(msg => {
          if (msg.type === 'alerts' && msg.timestamp > lastAlertTimestamp) {
            lastAlertTimestamp = msg.timestamp;
          }
        });
      }

      if (!lastAlertTimestamp || now - lastAlertTimestamp >= 2*60*1000) {
        await logMessage(deviceId, 'alerts', payload);
        console.log(`[alerts] saved for ${deviceId}`);

        const usersSnapshot = await db.ref('users').once('value');
        const usersData = usersSnapshot.val();
        
        let targetUser = null;
        if (usersData) {
          Object.keys(usersData).forEach(userId => {
            const userData = usersData[userId];
            if (userData.userDevices && userData.userDevices[deviceId]) {
              targetUser = { id: userId, data: userData };
            }
          });
        }

        if (targetUser && targetUser.data.fcmToken) {
          const alertData = {
            id: '', 
            deviceId,
            deviceName: targetUser.data.userDevices[deviceId]?.customName || deviceId,
            deviceType: '', 
            message: payload,
            severity: '', 
            timestamp: now.toString()
          };

          await admin.messaging().send({
            token: targetUser.data.fcmToken,
            data: alertData,
            notification: {
              title: `Security Alert - ${alertData.deviceName}`,
              body: alertData.message
            }
          });
          console.log(`[alerts] FCM sent to user ${targetUser.id}`);
        } else {
          console.log(`[alerts] No FCM token found for device ${deviceId}`);
        }
      } else {
        console.log(`[alerts] skipped for ${deviceId} (<2min)`);
      }
    }

    else if (messageType === 'query') {
      await logMessage(deviceId, 'query', payload);
      console.log(`[query] saved for ${deviceId}`);
    }

    else {
      await logMessage(deviceId, messageType, payload);
      console.log(`[${messageType}] saved for ${deviceId}`);
    }
  }
  catch (err) {
    console.error('Error handling message:', err);
  }
});

const MARK_OFFLINE_INTERVAL_MS = 60 * 1000;    
const OFFLINE_THRESHOLD_MS     = 2 * 60 * 1000; 

setInterval(async () => {
  try {
    const now = Date.now();
    const cutoff = now - OFFLINE_THRESHOLD_MS;

    const devicesSnapshot = await db.ref('devices').once('value');
    const devicesData = devicesSnapshot.val();
    
    if (!devicesData) {
      console.log('No devices found in database.');
      return;
    }

    const staleDevices = [];
    Object.keys(devicesData).forEach(deviceId => {
      const data = devicesData[deviceId];

      if (
        data.lastUpdate && 
        data.lastUpdate < cutoff &&
        data.status !== 'OFFLINE' &&
        data.status !== 'MAINTENANCE'  
      ) {
        staleDevices.push({ id: deviceId, data });
      }
    });

    if (staleDevices.length === 0) {
      console.log('No stale devices found.');
      return;
    }

    console.log(`Found ${staleDevices.length} stale devices to mark as OFFLINE.`);

    for (const { id: deviceId } of staleDevices) {
      try {
        await logMessage(deviceId, 'offline', 'timeout');
        
        await db.ref(`devices/${deviceId}`).update({ 
          status: 'OFFLINE', 
          lastUpdate: now 
        });

        deviceCache.set(deviceId, {
          status: 'OFFLINE',
          lastUpdate: now,
          lastMessageTime: Date.now()
        });

        console.log(`[offline] marking ${deviceId} as OFFLINE`);
      } catch (error) {
        console.error(`Error marking device ${deviceId} as offline:`, error);
      }
    }
    
    console.log(`Successfully marked ${staleDevices.length} devices as OFFLINE due to inactivity.`);
    
  } catch (error) {
    console.error('Error in offline device marking interval:', error);
  }
}, MARK_OFFLINE_INTERVAL_MS);

process.on('SIGINT', () => {
  console.log('Received SIGINT. Gracefully shutting down...');
  client.end();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Gracefully shutting down...');
  client.end();
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  client.end();
  process.exit(1);
});