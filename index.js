const path  = require('path');
const admin = require('firebase-admin');
const mqtt  = require('mqtt');

const serviceAccount = require(path.join(
  __dirname,
  'guardianhive-8e3e0-firebase-adminsdk-fbsvc-22bafbbeba.json'
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

client.on('connect', () => {
  console.log('🔌 Connected to MQTT broker');
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
        console.log(`⏭ [alerts] skipped for ${deviceId} (<2min)`);
      }
    }

    else if (messageType === 'availability') {
      const status = payload; 

      const snap = await db.collection('mqtt_messages')
        .where('deviceId','==',deviceId)
        .where('type','==','availability')
        .orderBy('timestamp','desc')
        .limit(1)
        .get();
      const lastStatus = !snap.empty && snap.docs[0].data().payload;
      if (lastStatus !== status) {
        await logMessage(deviceId, 'availability', status);
        console.log(`[availability:${status}] logged for ${deviceId}`);
      } else {
        console.log(`[availability:${status}] no change for ${deviceId}`);
      }

      await db.collection('deviceStatus')
        .doc(deviceId)
        .set({ status, lastUpdate: now }, { merge: true });
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
  const now    = admin.firestore.Timestamp.now();
  const cutoff = admin.firestore.Timestamp.fromMillis(now.toMillis() - DEAD_THRESHOLD_MS);

  const stale = await db.collection('deviceStatus')
    .where('lastUpdate', '<', cutoff)
    .where('status', '!=', 'dead')
    .get();

  if (stale.empty) return;

  const batch = db.batch();
  stale.forEach(doc => {
    const deviceId = doc.id;
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
  console.log(`Marked ${stale.size} devices as dead due to inactivity.`);
}, MARK_DEAD_INTERVAL_MS);
