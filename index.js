#!/usr/bin/env node

const plugin = require('ilp-plugin')();
const { createConnection } = require('ilp-protocol-stream');
const { URL } = require('url');
const fetch = require('node-fetch');

if (process.argv.length <= 3) {
    console.log("Usage: node index.js receiver amount");
    console.log("sample: node index.js '$twitter.xrptipbot.com/WietseWind' 5000");
    process.exit(-1);
}

const receiver = process.argv[2];
const amount = process.argv[3];

// To request info from the ILP payment pointer (who are you, what's our shared secret?)
async function query (receiver) {
  const endpoint = new URL(receiver.startsWith('$') ? 'https://' + receiver.substring(1) : receiver);
  endpoint.pathname = endpoint.pathname === '/' ? '/.well-known/pay' : endpoint.pathname;
  const response = await fetch(endpoint.href, { headers: { accept: 'application/spsp4+json, application/spsp+json' } });

  if (response.status !== 200) {
    throw new Error(`Got error response from SPSP receiver. endpoint="${endpoint.href}" status=${response.status} message="${await response.text()}"`)
  }

  const json = await response.json();

  return {
    destinationAccount: json.destination_account,
    sharedSecret: Buffer.from(json.shared_secret, 'base64'),
    contentType: response.headers.get('content-type'),
    // Unused in simple ILP XRP-XRP example:
    balance: json.balance,
    ledgerInfo: json.ledger_info,
    receiverInfo: json.receiver_info
  }
}

// To start sending the payment
const pay = (destination, amount) => {
  return new Promise((resolve, reject) => {
    return (async () => {
      console.log(`Connecting plugin (to local moneyd)`);
      await plugin.connect();

      console.log(`Sending payment. Paying ${amount} to "${destination}"\n`);
      console.log(`  - Fetching ILP payment pointer details`);
      const response = await query(destination);
      console.log(`    -> ILP address ${response.destinationAccount}`);

      if (response.contentType.indexOf('application/spsp4+json') !== -1) {
        let packetCount = 0;
        let lastDeliveredAmount = 0;
        const ilpConn = await createConnection({ plugin, destinationAccount: response.destinationAccount, sharedSecret: response.sharedSecret });

        const payStream = ilpConn.createStream();
        payStream.setSendMax(amount);
        payStream.on('error', reject);

        payStream.on('outgoing_money', () => {
          console.log(`  > $ Sending...`);
          packetCount++
        });

        let deliveredInterval = setInterval(() => {
          if (ilpConn.totalDelivered > 0 && ilpConn.totalDelivered !== lastDeliveredAmount) {
            if (lastDeliveredAmount === parseFloat(amount)) clearInterval(deliveredInterval);
            lastDeliveredAmount = ilpConn.totalDelivered;
            console.log(`  < $ Delivered ${lastDeliveredAmount}`)

            // You can always decide it's enough at some point by re-setting the sendMax.
            // payStream.setSendMax(2000)
          }
        }, 250);

        payStream.on('end', async () => {
          clearInterval(deliveredInterval);
          const resolveData = { amount: ilpConn.totalDelivered, destination: destination, packets: packetCount };
          await payStream.destroy();
          await ilpConn.end();
          resolve(resolveData)
        })
      } else {
        reject(new Error('No application/spsp4+json content-type received from payment pointer', destination))
      }
    })()
  })
};

// Now start the payment :)
pay(receiver, amount).then(payment => {
  console.log(`\n:D Sent ${payment.amount} to ${payment.destination} in ${payment.packets} packets\n`)
});
