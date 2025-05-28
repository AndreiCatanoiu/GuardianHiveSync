const path  = require('path');
const admin = require('firebase-admin');
const mqtt  = require('mqtt');

const serviceAccount = require(path.join(
  __dirname,
  'guardianhive-8e3e0-firebase-adminsdk-fbsvc-ab9a2fc414.json'
));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
console.log('Firebase Admin initialized.');

const client = mqtt.connect('mqtt://www.andreicatanoiu.ro', {
  port:     1883,
  username: 'admin',
  password: 'admin',
});

const deviceCache = new Map();

client.on('connect', async () => {
  console.log('Connected to MQTT broker');
  
  try {
    const snapshot = await db.collection('deviceStatus').get();
    snapshot.forEach(doc => {
      const data = doc.data();
      deviceCache.set(doc.id, {
        status: data.status,
        lastUpdate: data.lastUpdate?.toMillis() || 0,
        lastMessageTime: Date.now()
      });
    });
    console.log(`Loaded ${deviceCache.size} devices into cache`);
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
  const now = admin.firestore.Timestamp.now();
  await db.collection('mqtt_messages')
    .add({ deviceId, type, payload, timestamp: now });
}

client.on('message', async (topic, payloadBuffer) => {
  const payload     = payloadBuffer.toString();
  const parts       = topic.split('/');
  const deviceId    = parts[4];
  const messageType = parts[5];      
  const now         = admin.firestore.Timestamp.now();

  try {
    if (messageType === 'alerts') {
      const snap = await db.collection('mqtt_messages')
        .where('deviceId','==',deviceId)
        .where('type','==','alerts')
        .orderBy('timestamp','desc')
        .limit(1)
        .get();
      const lastTs = !snap.empty && snap.docs[0].data().timestamp.toMillis();
      if (!lastTs || now.toMillis() - lastTs >= 2*60*1000) {
        await logMessage(deviceId, 'alerts', payload);
        console.log(`[alerts] saved for ${deviceId}`);
      } else {
        console.log(`[alerts] skipped for ${deviceId} (<2min)`);
      }
    }

    else if (messageType === 'availability') {
      const status = payload;
      
      const cached = deviceCache.get(deviceId);
      const currentStatus = cached?.status;
      const lastMessageTime = cached?.lastMessageTime || 0;
      const timeSinceLastMessage = Date.now() - lastMessageTime;
      
      const statusChanged = currentStatus !== status;
      const needsRevalidation = timeSinceLastMessage >= 2*60*1000;
      
      if (statusChanged || needsRevalidation) {
        if (statusChanged) {
          await logMessage(deviceId, 'availability', status);
        }
        
        await db.collection('deviceStatus')
          .doc(deviceId)
          .set({ status, lastUpdate: now }, { merge: true });
          
        console.log(`[availability:${status}] updated for ${deviceId} (${statusChanged ? 'changed' : 'revalidation'})`);
      } else {
        console.log(`[availability:${status}] no update needed for ${deviceId}`);
      }
      
      deviceCache.set(deviceId, {
        status,
        lastUpdate: now.toMillis(),
        lastMessageTime: Date.now()
      });
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

const MARK_DEAD_INTERVAL_MS = 60 * 1000;    
const DEAD_THRESHOLD_MS     = 2 * 60 * 1000; 

setInterval(async () => {
  try {
    const now    = admin.firestore.Timestamp.now();
    const cutoff = admin.firestore.Timestamp.fromMillis(now.toMillis() - DEAD_THRESHOLD_MS);

    const allDevices = await db.collection('deviceStatus').get();
    
    const staleDevices = [];
    allDevices.forEach(doc => {
      const data = doc.data();
      const deviceId = doc.id;

      if (data.lastUpdate && 
          data.lastUpdate.toMillis() < cutoff.toMillis() && 
          data.status !== 'dead') {
        staleDevices.push({ id: deviceId, data });
      }
    });

    if (staleDevices.length === 0) {
      console.log('No stale devices found.');
      return;
    }

    console.log(`Found ${staleDevices.length} stale devices to mark as dead.`);

    const BATCH_SIZE = 500;
    
    for (let i = 0; i < staleDevices.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const batchDevices = staleDevices.slice(i, i + BATCH_SIZE);
      
      batchDevices.forEach(({ id: deviceId }) => {
        const deadRef = db.collection('mqtt_messages').doc();
        batch.set(deadRef, {
          deviceId,
          type:      'dead',
          payload:   '',
          timestamp: now
        });
        
        const statusRef = db.collection('deviceStatus').doc(deviceId);
        batch.update(statusRef, { status: 'dead', lastUpdate: now });

        console.log(`[dead] marking ${deviceId} as dead`);
      });
      
      await batch.commit();
      console.log(`Processed batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(staleDevices.length/BATCH_SIZE)}`);
    }
    
    console.log(`Successfully marked ${staleDevices.length} devices as dead due to inactivity.`);
    
  } catch (error) {
    console.error('Error in dead device marking interval:', error);
  }
}, MARK_DEAD_INTERVAL_MS);

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