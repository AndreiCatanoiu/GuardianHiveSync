const path  = require('path');
const admin = require('firebase-admin');
const mqtt  = require('mqtt');

const serviceAccount = require('./guardianhive-8e3e0-firebase-adminsdk-fbsvc-ab9a2fc414.json');

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

async function getAllUserFCMTokens(userId) {
  try {
    const userSnapshot = await db.ref(`users/${userId}/fcmTokens`).once('value');
    const fcmTokensData = userSnapshot.val();
    
    if (fcmTokensData) {
      return Object.keys(fcmTokensData).filter(token => fcmTokensData[token] === true);
    }
    return [];
  } catch (error) {
    console.error(`Error getting FCM tokens for user ${userId}:`, error);
    return [];
  }
}

async function sendNotificationToAllUserDevices(userId, deviceId, alertData) {
  try {
    const tokens = await getAllUserFCMTokens(userId);
    
    if (tokens.length === 0) {
      console.log(`[alerts] No FCM tokens found for user ${userId}`);
      return;
    }

    const message = {
      data: {
        deviceId: deviceId,
        alertType: 'security',
        timestamp: Date.now().toString(),
        ...alertData
      },
      notification: {
        title: `Security Alert - ${alertData.deviceName || 'Unknown device'}`,
        body: alertData.message || 'Suspicious activity detected'
      }
    };

    const responses = await Promise.all(tokens.map(token =>
      admin.messaging().send({ ...message, token }).then(
        res => ({ token, success: true }),
        err => ({ token, success: false, error: err })
      )
    ));

    for (const res of responses) {
      if (!res.success && res.error.code === 'messaging/registration-token-not-registered') {
        try {
          await db.ref(`users/${userId}/fcmTokens/${res.token}`).remove();
          console.log(`[alerts] Token invalid șters: ${res.token.substring(0, 20)}...`);
        } catch (removeError) {
          console.error(`[alerts] Error removing invalid token:`, removeError);
        }
      } else if (!res.success) {
        console.error(`[alerts] Failed to send FCM to token ${res.token.substring(0, 20)}...:`, res.error.message);
      } else {
        console.log(`[alerts] FCM sent successfully to token: ${res.token.substring(0, 20)}...`);
      }
    }

    const results = responses;
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`[alerts] FCM notifications sent to user ${userId}: ${successful} successful, ${failed} failed out of ${tokens.length} total devices`);
    
    return {
      totalTokens: tokens.length,
      successful,
      failed,
      results
    };

  } catch (error) {
    console.error(`[alerts] Error sending notifications to user ${userId}:`, error);
    return { error: error.message };
  }
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

        console.log(`[alerts] Searching for all users with device ${deviceId}...`);
        const usersSnapshot = await db.ref('users').once('value');
        const usersData = usersSnapshot.val();
        
        const targetUsers = [];
        if (usersData) {
          Object.keys(usersData).forEach(userId => {
            const userData = usersData[userId];
            console.log(`[alerts] Checking user ${userId}...`);
            if (userData.userDevices) {
              console.log(`[alerts] User ${userId} has userDevices:`, Object.keys(userData.userDevices));
              if (userData.userDevices[deviceId]) {
                targetUsers.push({ id: userId, data: userData });
                console.log(`[alerts] ✓ User ${userId} has device ${deviceId} - adding to notification list`);
              } else {
                console.log(`[alerts] ✗ User ${userId} does NOT have device ${deviceId}`);
              }
            } else {
              console.log(`[alerts] ✗ User ${userId} has no userDevices`);
            }
          });
          console.log(`[alerts] Total users found with device ${deviceId}: ${targetUsers.length}`);
        } else {
          console.log(`[alerts] No users data found in database`);
        }

        if (targetUsers.length > 0) {
          console.log(`[alerts] Found ${targetUsers.length} users with device ${deviceId}`);
          
          let totalNotificationsSent = 0;
          let totalDevicesReached = 0;
          
          for (const targetUser of targetUsers) {
            let deviceName = 'Unknown device';
            try {
              const deviceSnapshot = await db.ref(`devices/${deviceId}`).once('value');
              const deviceData = deviceSnapshot.val();
              if (deviceData && deviceData.name) {
                deviceName = targetUser.data.userDevices[deviceId]?.customName || deviceData.name || deviceId;
              } else {
                deviceName = targetUser.data.userDevices[deviceId]?.customName || deviceId;
              }
            } catch (error) {
              console.error(`Error getting device name for ${deviceId}:`, error);
            }

            let alertData = {
              deviceName: deviceName,
              message: 'Suspicious activity detected'
            };

            try {
              const parsedPayload = JSON.parse(payload);
              alertData = {
                deviceName: deviceName,
                message: parsedPayload.message || 'Suspicious activity detected',
                alertType: parsedPayload.type || 'security',
                location: parsedPayload.location || '',
                severity: parsedPayload.severity || 'medium'
              };
            } catch (parseError) {
              alertData.message = payload || 'Suspicious activity detected';
            }

            try {
              const notificationResult = await sendNotificationToAllUserDevices(
                targetUser.id, 
                deviceId, 
                alertData
              );

              if (notificationResult.error) {
                console.log(`[alerts] Error sending notifications to user ${targetUser.id}: ${notificationResult.error}`);
              } else {
                totalNotificationsSent += notificationResult.successful;
                totalDevicesReached += notificationResult.totalTokens;
                console.log(`[alerts] Notifications sent to user ${targetUser.id}: ${notificationResult.successful}/${notificationResult.totalTokens} devices`);
              }
            } catch (error) {
              console.error(`[alerts] Error processing notifications for user ${targetUser.id}:`, error);
            }
          }

          console.log(`[alerts] TOTAL: ${totalNotificationsSent} notifications sent across ${totalDevicesReached} devices for ${targetUsers.length} users`);
        } else {
          console.log(`[alerts] No users found for device ${deviceId}`);
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