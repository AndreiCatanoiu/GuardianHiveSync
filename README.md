# GuardianHiveSync

## Description

GuardianHiveSync is a Node.js application that subscribes to MQTT topics from sensors and logs incoming messages to a Fireabse Realtime Database. It also monitors device status and automatically marks devices as `offline` if they become inactive for a configured period.

## Features

* Connects to an MQTT broker and subscribes to sensor topics.
* Saves various message types (`alerts`, `availability`, `query`, etc.) to the `mqtt_messages` collection in Firebase.
* Updates device status documents in the `deviceStatus` collection with `online`, `offline`, or `maintenance` states.
* Automatically marks devices as `offline` if no data is received for more than 2 minutes, logging the events accordingly.

## Prerequisites

* Node.js v12 or higher
* Access to an MQTT broker

## Installation

1. Clone this repository:

   ```bash
   git clone https://github.com/AndreiCatanoiu/GuardianHiveSync.git
   cd GuardianHiveSync
   ```
2. Install dependencies:

   ```bash
   npm install
   ```

## Configuration

 Open `index.js` and update the following if necessary:

   * MQTT broker connection settings (`host`, `port`, `username`, `password`).
   * Subscription topic (default: `senzor/licenta/andrei/catanoiu/+/+`).

## MQTT Topic Structure

Sensors should publish messages to the following topic:

```
senzor/licenta/andrei/catanoiu/{deviceId}/{messageType}
```

* `{deviceId}`: Unique identifier of the device.
* `{messageType}`: Type of the message (`alerts`, `availability`, `query`, etc.).


* **Collection `deviceStatus`**: tracks each device's status:

  * `status` (string): `online`, `offline`, or `maintenance`
  * `lastUpdate` (Firestore Timestamp)

## Usage

Start the application:

```bash
node index.js
```

On startup, the app will initialize the Firebase Admin SDK, connect to the MQTT broker, and begin processing incoming messages.

## Inactive Device Handling

Every 60 seconds, the app checks for devices that haven’t sent data in the last 2 minutes and marks them as `offline`, logging each event.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
