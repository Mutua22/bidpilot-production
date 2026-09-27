# BidPilot Production Package

A production-oriented marketing site + license API + M-Pesa STK Push integration.

Start locally:
1. `npm install`
2. `npm start`
3. Open `http://localhost:3000`

Admin: `http://localhost:3000/admin`

**Security:** `.env` contains sensitive credentials and must never be committed to GitHub. Rotate any credential that has been exposed before production.

The included extension ZIPs are a license-gate shell. Merge them into the actual BidPilot bot extension before customer distribution.
