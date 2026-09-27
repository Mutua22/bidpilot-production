require("dotenv").config();

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/downloads",
  express.static(path.join(__dirname, "downloads"))
);


/*
========================================================
DATABASE
========================================================
*/

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "store.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(
      {
        customers: [],
        licenses: [],
        payments: [],
        admins: [],
        c2bTransactions: []
      },
      null,
      2
    )
  );
}

function db() {
  try {
    return JSON.parse(
      fs.readFileSync(DB_FILE, "utf8")
    );
  } catch (e) {
    console.error("Database read error:", e);

    return {
      customers: [],
      licenses: [],
      payments: [],
      admins: [],
      c2bTransactions: []
    };
  }
}

function save(data) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(data, null, 2)
  );
}


/*
========================================================
HELPERS
========================================================
*/

function id(prefix = "BP") {
  return (
    prefix +
    "-" +
    crypto
      .randomBytes(9)
      .toString("hex")
      .toUpperCase()
  );
}

function now() {
  return new Date().toISOString();
}


/*
========================================================
PLANS
========================================================
*/

const PLANS = {
  trial7: {
    name: "7-Day",
    days: 7,
    usd: 2.99,
    description:
      "Try every core feature for one week on one device."
  },

  monthly: {
    name: "Monthly",
    days: 30,
    usd: 10,
    description:
      "For regular freelancers who want consistent bidding automation."
  },

  quarterly: {
    name: "Quarterly",
    days: 90,
    usd: 24.99,
    description:
      "A popular value plan for freelancers who want three months of access."
  },

  annual: {
    name: "Annual",
    days: 365,
    usd: 93,
    description:
      "Best value for serious users who want a full year of BidPilot."
  }
};


/*
========================================================
ADMIN AUTHENTICATION
========================================================
*/

function authAdmin(req, res, next) {
  const h =
    req.headers.authorization || "";

  if (!h.startsWith("Basic ")) {
    return res.status(401).json({
      error: "Admin login required"
    });
  }

  const decoded =
    Buffer
      .from(h.slice(6), "base64")
      .toString();

  const separator =
    decoded.indexOf(":");

  if (separator === -1) {
    return res.status(401).json({
      error: "Invalid admin login"
    });
  }

  const email =
    decoded.slice(0, separator);

  const password =
    decoded.slice(separator + 1);

  if (
    email !== process.env.ADMIN_EMAIL ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: "Invalid admin login"
    });
  }

  next();
}


/*
========================================================
PHONE NORMALIZATION
========================================================
*/

function normalizePhone(phone) {
  let p =
    String(phone || "")
      .replace(/\s+/g, "")
      .replace(/^\+/, "");

  if (p.startsWith("0")) {
    p = "254" + p.slice(1);
  }

  if (p.startsWith("7")) {
    p = "254" + p;
  }

  return p;
}


/*
========================================================
TIMESTAMP
========================================================
*/

function mpesaTimestamp() {
  const d = new Date();

  const pad =
    n =>
      String(n).padStart(2, "0");

  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}


/*
========================================================
M-PESA BASE URL
========================================================
*/

function mpesaBaseUrl() {
  return (
    String(process.env.MPESA_ENV || "sandbox")
      .toLowerCase() === "live"
  )
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}


/*
========================================================
M-PESA CONFIGURATION
========================================================

IMPORTANT:

SHORTCODE = 4348815

PARTY B / TILL = 1634955

Keep these in Railway variables:

MPESA_SHORTCODE=4348815
MPESA_PARTY_B=1634955
MPESA_ENV=live

========================================================
*/

function getShortcode() {
  return (
    process.env.MPESA_SHORTCODE ||
    "4348815"
  );
}

function getPartyB() {
  return (
    process.env.MPESA_PARTY_B ||
    "1634955"
  );
}


/*
========================================================
CALLBACK URL
========================================================
*/

function getMpesaCallbackUrl() {
  if (process.env.MPESA_CALLBACK_URL) {
    return process.env.MPESA_CALLBACK_URL
      .trim()
      .replace(/\/$/, "");
  }

  const baseUrl =
    (process.env.BASE_URL || "")
      .trim()
      .replace(/\/$/, "");

  if (!baseUrl) {
    throw new Error(
      "BASE_URL or MPESA_CALLBACK_URL is not configured"
    );
  }

  return (
    baseUrl +
    "/api/payments/callback"
  );
}


/*
========================================================
M-PESA ACCESS TOKEN
========================================================
*/

async function mpesaToken() {
  if (
    !process.env.MPESA_CONSUMER_KEY ||
    !process.env.MPESA_CONSUMER_SECRET
  ) {
    throw new Error(
      "M-Pesa Consumer Key/Secret are not configured"
    );
  }

  const base =
    mpesaBaseUrl();

  const auth =
    Buffer
      .from(
        `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
      )
      .toString("base64");

  const response =
    await axios.get(
      base +
      "/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: {
          Authorization:
            `Basic ${auth}`
        },

        timeout: 20000
      }
    );

  if (
    !response.data ||
    !response.data.access_token
  ) {
    throw new Error(
      "Safaricom authorization did not return an access token"
    );
  }

  return {
    token:
      response.data.access_token,

    base
  };
}


/*
========================================================
INITIATE STK PUSH
========================================================
*/

async function initiateMpesa({
  phone,
  amount,
  accountRef,
  description
}) {
  if (!process.env.MPESA_PASSKEY) {
    throw new Error(
      "MPESA_PASSKEY is not configured"
    );
  }

  const shortcode =
    getShortcode();

  const partyB =
    getPartyB();

  const {
    token,
    base
  } =
    await mpesaToken();

  const timestamp =
    mpesaTimestamp();

  /*
    Password is generated using the
    configured BusinessShortCode.
  */

  const password =
    Buffer
      .from(
        `${shortcode}${process.env.MPESA_PASSKEY}${timestamp}`
      )
      .toString("base64");

  const callback =
    getMpesaCallbackUrl();

  const transactionType =
    process.env.MPESA_TRANSACTION_TYPE ||
    "CustomerBuyGoodsOnline";

  const normalizedPhone =
    normalizePhone(phone);

  if (
    !/^2547\d{8}$/.test(
      normalizedPhone
    )
  ) {
    throw new Error(
      "Invalid Kenyan mobile number"
    );
  }

  const numericAmount =
    Math.max(
      1,
      Math.ceil(
        Number(amount)
      )
    );

  /*
    IMPORTANT:

    BusinessShortCode = 4348815
    PartyB            = 1634955

    This keeps the shortcode and till
    separate.
  */

  const payload = {
    BusinessShortCode:
      shortcode,

    Password:
      password,

    Timestamp:
      timestamp,

    TransactionType:
      transactionType,

    Amount:
      numericAmount,

    PartyA:
      normalizedPhone,

    PartyB:
      partyB,

    PhoneNumber:
      normalizedPhone,

    CallBackURL:
      callback,

    AccountReference:
      accountRef,

    TransactionDesc:
      description
  };

  console.log(
    "M-PESA STK REQUEST",
    {
      environment:
        process.env.MPESA_ENV,

      businessShortCode:
        shortcode,

      partyB,

      transactionType,

      amount:
        numericAmount,

      phoneLast4:
        normalizedPhone.slice(-4),

      callback
    }
  );

  try {
    const response =
      await axios.post(
        base +
        "/mpesa/stkpush/v1/processrequest",

        payload,

        {
          headers: {
            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json"
          },

          timeout: 30000
        }
      );

    console.log(
      "M-PESA STK RESPONSE",
      {
        responseCode:
          response.data?.ResponseCode,

        responseDescription:
          response.data?.ResponseDescription,

        merchantRequestId:
          response.data?.MerchantRequestID ||
          null,

        checkoutRequestId:
          response.data?.CheckoutRequestID ||
          null,

        customerMessage:
          response.data?.CustomerMessage ||
          null
      }
    );

    return response.data;

  } catch (error) {
    console.error(
      "M-PESA STK REQUEST FAILED",
      {
        status:
          error.response?.status ||
          null,

        data:
          error.response?.data ||
          null,

        message:
          error.message
      }
    );

    throw error;
  }
}


/*
========================================================
CREATE LICENSE
========================================================
*/

function createLicense(
  customer,
  planKey,
  paymentId,
  product = "studypool"
) {
  const data =
    db();

  const plan =
    PLANS[planKey];

  const expires =
    new Date(
      Date.now() +
      plan.days *
      86400000
    ).toISOString();

  const license = {
    id:
      id("BP"),

    customerId:
      customer.id,

    email:
      customer.email,

    name:
      customer.name,

    plan:
      planKey,

    status:
      "active",

    expiresAt:
      expires,

    deviceId:
      null,

    paymentId:
      paymentId,

    product:
      product,

    createdAt:
      now()
  };

  data.licenses.push(
    license
  );

  save(data);

  console.log(
    "LICENSE CREATED",
    {
      licenseId:
        license.id,

      paymentId:
        paymentId,

      email:
        license.email,

      plan:
        planKey,

      expiresAt:
        expires
    }
  );

  return license;
}


/*
========================================================
CUSTOMER
========================================================
*/

function upsertCustomer(
  name,
  email,
  phone
) {
  const data =
    db();

  let customer =
    data.customers.find(
      x =>
        String(x.email || "")
          .toLowerCase() ===
        String(email || "")
          .toLowerCase()
    );

  if (!customer) {
    customer = {
      id:
        id("CUS"),

      name,

      email,

      phone,

      createdAt:
        now()
    };

    data.customers.push(
      customer
    );

    save(data);

  } else {
    let changed = false;

    if (
      name &&
      customer.name !== name
    ) {
      customer.name =
        name;

      changed = true;
    }

    if (
      phone &&
      customer.phone !== phone
    ) {
      customer.phone =
        phone;

      changed = true;
    }

    if (changed) {
      save(data);
    }
  }

  return customer;
}


/*
========================================================
EMAIL LICENSE
========================================================
*/

async function sendLicenseEmail(
  license
) {
  if (!process.env.SMTP_HOST) {
    console.log(
      "SMTP not configured. License will still be shown on website."
    );

    return false;
  }

  const transporter =
    nodemailer.createTransport({
      host:
        process.env.SMTP_HOST,

      port:
        Number(
          process.env.SMTP_PORT ||
          587
        ),

      secure:
        Number(
          process.env.SMTP_PORT ||
          587
        ) === 465,

      auth: {
        user:
          process.env.SMTP_USER,

        pass:
          process.env.SMTP_PASS
      }
    });

  const plan =
    PLANS[license.plan];

  await transporter.sendMail({
    from:
      process.env.SMTP_FROM ||
      process.env.SMTP_USER,

    to:
      license.email,

    subject:
      "Your BidPilot activation code",

    text:
`Hello ${license.name},

Your payment was successful.

Your BidPilot activation code is:

${license.id}

Plan:
${plan.name}

Expires:
${license.expiresAt}

Enter this activation code in BidPilot to activate your license.

Keep this code private.

Thank you.`
  });

  console.log(
    "LICENSE EMAIL SENT",
    {
      email:
        license.email,

      licenseId:
        license.id
    }
  );

  return true;
}


/*
========================================================
HEALTH CHECK
========================================================
*/

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok:
        true,

      service:
        "BidPilot",

      mpesaEnvironment:
        process.env.MPESA_ENV ||
        "sandbox",

      businessShortCode:
        getShortcode(),

      partyB:
        getPartyB(),

      transactionType:
        process.env.MPESA_TRANSACTION_TYPE ||
        "CustomerBuyGoodsOnline",

      callback:
        getMpesaCallbackUrl()
    });
  }
);


/*
========================================================
PLANS
========================================================
*/

app.get(
  "/api/plans",
  (req, res) => {
    res.json(
      PLANS
    );
  }
);


/*
========================================================
CHECKOUT
========================================================
*/

app.post(
  "/api/checkout/mpesa",
  async (req, res) => {
    try {
      const {
        name,
        email,
        phone,
        plan,
        product = "studypool"
      } =
        req.body;

      if (
        !name ||
        !email ||
        !phone ||
        !PLANS[plan] ||
        !["studypool", "essaypro"].includes(String(product).toLowerCase())
      ) {
        return res.status(400).json({
          ok:
            false,

          error:
            "Name, email, phone and valid plan are required"
        });
      }

      const customer =
        upsertCustomer(
          name.trim(),
          email.trim(),
          phone
        );

      const exchangeRate =
        Number(
          process.env.MPESA_USD_TO_KES ||
          130
        );

      const amount =
        Math.max(
          1,
          Math.ceil(
            PLANS[plan].usd *
            exchangeRate
          )
        );

      const payment = {
        id:
          id("PAY"),

        provider:
          "mpesa",

        customerId:
          customer.id,

        plan,

        product:
          String(product).toLowerCase(),

        usd:
          PLANS[plan].usd,

        kes:
          amount,

        status:
          "pending",

        createdAt:
          now()
      };

      const data =
        db();

      data.payments.push(
        payment
      );

      save(data);

      console.log(
        "PAYMENT CREATED",
        {
          paymentId:
            payment.id,

          customerId:
            customer.id,

          amount:

            amount,

          plan
        }
      );

      const result =
        await initiateMpesa({
          phone,

          amount,

          accountRef:
            payment.id,

          description:
            `BidPilot ${PLANS[plan].name}`
        });

      const updated =
        db();

      const storedPayment =
        updated.payments.find(
          x =>
            x.id ===
            payment.id
        );

      if (!storedPayment) {
        throw new Error(
          "Payment record disappeared"
        );
      }

      storedPayment.checkoutRequestId =
        result.CheckoutRequestID ||
        null;

      storedPayment.merchantRequestId =
        result.MerchantRequestID ||
        null;

      storedPayment.responseCode =
        result.ResponseCode ??
        null;

      storedPayment.responseDescription =
        result.ResponseDescription ||
        null;

      storedPayment.customerMessage =
        result.CustomerMessage ||
        null;

      storedPayment.rawResponse =
        result;

      if (
        String(
          result.ResponseCode
        ) !== "0"
      ) {
        storedPayment.status =
          "request_failed";
      }

      save(updated);

      /*
        DO NOT CREATE THE LICENSE HERE.

        The STK response only confirms that
        the request was accepted.

        The license is created only after
        the callback confirms ResultCode = 0.
      */

      return res.json({
        ok:
          String(
            result.ResponseCode
          ) === "0",

        paymentId:
          payment.id,

        checkoutRequestId:
          result.CheckoutRequestID ||
          null,

        responseCode:
          result.ResponseCode ??
          null,

        responseDescription:
          result.ResponseDescription ||
          null,

        customerMessage:
          result.CustomerMessage ||
          null
      });

    } catch (error) {
      console.error(
        "CHECKOUT ERROR",
        {
          message:
            error.message,

          data:
            error.response?.data ||
            null
        }
      );

      return res.status(500).json({
        ok:
          false,

        error:
          error.response?.data?.errorMessage ||
          error.response?.data?.ResponseDescription ||
          error.message
      });
    }
  }
);


/*
========================================================
PAYMENT STATUS
========================================================

The checkout page polls this endpoint.

When the callback changes payment.status
to "paid", the license is returned here.

========================================================
*/

app.get(
  "/api/payments/:paymentId",
  (req, res) => {
    const data =
      db();

    const payment =
      data.payments.find(
        x =>
          x.id ===
          req.params.paymentId
      );

    if (!payment) {
      return res.status(404).json({
        ok:
          false,

        error:
          "Payment not found"
      });
    }

    const license =
      data.licenses.find(
        x =>
          x.paymentId ===
          payment.id
      );

    /*
      We return the license only when
      the payment has actually been paid.
    */

    return res.json({
      ok:
        true,

      payment: {
        id:
          payment.id,

        status:
          payment.status,

        plan:
          payment.plan,

        product:
          payment.product || "studypool",

        kes:
          payment.kes,

        checkoutRequestId:
          payment.checkoutRequestId ||
          null,

        responseCode:
          payment.responseCode ??
          null,

        responseDescription:
          payment.responseDescription ||
          null,

        resultCode:
          payment.resultCode ??
          null,

        resultDesc:
          payment.resultDesc ||
          null,

        receipt:
          payment.receipt ||
          null
      },

      license:
        payment.status === "paid"
          ? (
              license
                ? {
                    id:
                      license.id,

                    plan:
                      license.plan,

                    product:
                      license.product || "studypool",

                    status:
                      license.status,

                    expiresAt:
                      license.expiresAt
                  }
                : null
            )
          : null
    });
  }
);


/*
========================================================
STK CALLBACK
========================================================
*/

function handleMpesaCallback(
  req,
  res
) {
  try {
    const callback =
      req.body?.Body?.stkCallback;

    console.log(
      "M-PESA STK CALLBACK RECEIVED:",
      {
        resultCode:
          callback?.ResultCode ??
          null,

        resultDesc:
          callback?.ResultDesc ??
          null,

        checkoutRequestId:
          callback?.CheckoutRequestID ??
          null,

        merchantRequestId:
          callback?.MerchantRequestID ??
          null
      }
    );

    if (!callback) {
      return res.json({
        ResultCode:
          0,

        ResultDesc:
          "Accepted"
      });
    }

    const data =
      db();

    const payment =
      data.payments.find(
        x =>
          x.checkoutRequestId ===
          callback.CheckoutRequestID
      );

    if (!payment) {
      console.warn(
        "NO PAYMENT MATCHED CALLBACK",
        callback.CheckoutRequestID
      );

      return res.json({
        ResultCode:
          0,

        ResultDesc:
          "Accepted"
      });
    }

    payment.resultCode =
      callback.ResultCode;

    payment.resultDesc =
      callback.ResultDesc;

    payment.callbackAt =
      now();

    payment.rawCallback =
      req.body;

    /*
    ====================================================
    FAILED PAYMENT
    ====================================================
    */

    if (
      Number(
        callback.ResultCode
      ) !== 0
    ) {
      payment.status =
        "failed";

      save(data);

      console.log(
        "PAYMENT FAILED",
        {
          paymentId:
            payment.id,

          resultCode:
            callback.ResultCode,

          resultDesc:
            callback.ResultDesc
        }
      );

      return res.json({
        ResultCode:
          0,

        ResultDesc:
          "Accepted"
      });
    }


    /*
    ====================================================
    SUCCESSFUL PAYMENT
    ====================================================
    */

    const items =
      callback
        .CallbackMetadata
        ?.Item ||
      [];

    function metadataValue(
      field
    ) {
      const item =
        items.find(
          x =>
            x.Name ===
            field
        );

      return item
        ? item.Value
        : null;
    }

    const receivedAmount =
      Number(
        metadataValue(
          "Amount"
        ) || 0
      );

    const receipt =
      metadataValue(
        "MpesaReceiptNumber"
      );

    const transactionDate =
      metadataValue(
        "TransactionDate"
      );

    const phone =
      metadataValue(
        "PhoneNumber"
      );

    payment.receipt =
      receipt ||
      null;

    payment.amountReceived =
      receivedAmount;

    payment.transactionDate =
      transactionDate ||
      null;

    payment.phone =
      phone ||
      null;


    /*
    ====================================================
    AMOUNT VALIDATION
    ====================================================
    */

    if (
      receivedAmount !==
      Number(payment.kes)
    ) {
      payment.status =
        "amount_mismatch";

      save(data);

      console.error(
        "PAYMENT AMOUNT MISMATCH",
        {
          paymentId:
            payment.id,

          expected:
            payment.kes,

          received:
            receivedAmount
        }
      );

      return res.json({
        ResultCode:
          0,

        ResultDesc:
          "Accepted"
      });
    }


    /*
    ====================================================
    MARK PAID
    ====================================================
    */

    payment.status =
      "paid";

    save(data);

    console.log(
      "PAYMENT CONFIRMED",
      {
        paymentId:
          payment.id,

        receipt:
          payment.receipt,

        amount:
          payment.amountReceived
      }
    );


    /*
    ====================================================
    CREATE LICENSE
    ====================================================

    Prevent duplicate licenses if Safaricom
    sends the callback more than once.
    */

    const existingLicense =
      data.licenses.find(
        x =>
          x.paymentId ===
          payment.id
      );

    if (!existingLicense) {
      const customer =
        data.customers.find(
          x =>
            x.id ===
            payment.customerId
        );

      if (customer) {
        const license =
          createLicense(
            customer,

            payment.plan,

            payment.id,

            payment.product || "studypool"
          );

        /*
          createLicense() saves the database.

          Send email in the background.
        */

        sendLicenseEmail(
          license
        ).catch(
          error =>
            console.error(
              "LICENSE EMAIL ERROR:",
              error.message
            )
        );
      } else {
        console.error(
          "Customer not found for payment:",
          payment.id
        );
      }
    } else {
      console.log(
        "LICENSE ALREADY EXISTS:",
        existingLicense.id
      );
    }

    return res.json({
      ResultCode:
        0,

      ResultDesc:
        "Accepted"
    });

  } catch (error) {
    console.error(
      "M-PESA CALLBACK ERROR:",
      error
    );

    /*
      Acknowledge callback.
    */

    return res.json({
      ResultCode:
        0,

      ResultDesc:
        "Accepted"
    });
  }
}


/*
========================================================
STK CALLBACK ROUTES
========================================================
*/

app.post(
  "/api/payments/callback",
  handleMpesaCallback
);

app.post(
  "/api/payments/mpesa/callback",
  handleMpesaCallback
);


/*
========================================================
C2B VALIDATION
========================================================
*/

function handleC2BValidation(
  req,
  res
) {
  console.log(
    "C2B VALIDATION RECEIVED:",
    req.body
  );

  return res.json({
    ResultCode:
      0,

    ResultDesc:
      "Accepted"
  });
}


/*
========================================================
C2B CONFIRMATION
========================================================
*/

function handleC2BConfirmation(
  req,
  res
) {
  try {
    const data =
      db();

    if (
      !Array.isArray(
        data.c2bTransactions
      )
    ) {
      data.c2bTransactions =
        [];
    }

    const body =
      req.body || {};

    console.log(
      "C2B CONFIRMATION RECEIVED:",
      body
    );

    data.c2bTransactions.push({
      id:
        id("C2B"),

      receivedAt:
        now(),

      transactionType:
        body.TransactionType ||
        null,

      transId:
        body.TransID ||
        null,

      transTime:
        body.TransTime ||
        null,

      transAmount:
        body.TransAmount ||
        null,

      businessShortCode:
        body.BusinessShortCode ||
        null,

      billRefNumber:
        body.BillRefNumber ||
        null,

      invoiceNumber:
        body.InvoiceNumber ||
        null,

      orgAccountBalance:
        body.OrgAccountBalance ||
        null,

      thirdPartyTransId:
        body.ThirdPartyTransID ||
        null,

      msisdn:
        body.MSISDN ||
        null,

      firstName:
        body.FirstName ||
        null,

      middleName:
        body.MiddleName ||
        null,

      lastName:
        body.LastName ||
        null,

      raw:
        body
    });

    save(data);

    return res.json({
      ResultCode:
        0,

      ResultDesc:
        "Accepted"
    });

  } catch (error) {
    console.error(
      "C2B CONFIRMATION ERROR:",
      error
    );

    return res.json({
      ResultCode:
        0,

      ResultDesc:
        "Accepted"
    });
  }
}


/*
========================================================
C2B ROUTES
========================================================
*/

app.post(
  "/api/payments/mpesa/c2b/validation",
  handleC2BValidation
);

app.post(
  "/api/payments/mpesa/c2b/confirmation",
  handleC2BConfirmation
);

app.get(
  "/api/payments/mpesa/c2b/validation",
  (req, res) => {
    res.json({
      ok:
        true,

      endpoint:
        "c2b-validation"
    });
  }
);

app.get(
  "/api/payments/mpesa/c2b/confirmation",
  (req, res) => {
    res.json({
      ok:
        true,

      endpoint:
        "c2b-confirmation"
    });
  }
);


/*
========================================================
LICENSE ACTIVATION
========================================================
*/

app.post(
  "/api/license/activate",
  (req, res) => {
    const {
      licenseKey,
      deviceId,
      product
    } =
      req.body;

    const data =
      db();

    const license =
      data.licenses.find(
        x =>
          x.id ===
          licenseKey
      );

    if (!license) {
      return res.status(404).json({
        ok:
          false,

        error:
          "Invalid license"
      });
    }

    if (product && String(license.product || "studypool").toLowerCase() !== String(product).toLowerCase()) {
      return res.status(409).json({
        ok: false,
        error: "This license belongs to a different product"
      });
    }

    if (
      license.status !==
      "active"
    ) {
      return res.status(403).json({
        ok:
          false,

        error:
          "License disabled"
      });
    }

    if (
      new Date(
        license.expiresAt
      ) <= new Date()
    ) {
      license.status =
        "expired";

      save(data);

      return res.status(403).json({
        ok:
          false,

        error:
          "License expired"
      });
    }

    if (
      license.deviceId &&
      license.deviceId !==
      deviceId
    ) {
      return res.status(409).json({
        ok:
          false,

        error:
          "This license is already bound to another device"
      });
    }

    if (!license.deviceId) {
      license.deviceId =
        deviceId;
    }

    save(data);

    return res.json({
      ok:
        true,

      license: {
        id:
          license.id,

        plan:
          license.plan,

        product:
          license.product || "studypool",

        status:
          license.status,

        expiresAt:
          license.expiresAt,

        deviceBound:
          !!license.deviceId
      }
    });
  }
);


/*
========================================================
LICENSE CHECK
========================================================
*/

app.get(
  "/api/license/check",
  (req, res) => {
    const {
      licenseKey,
      deviceId
    } =
      req.query;

    const data =
      db();

    const license =
      data.licenses.find(
        x =>
          x.id ===
          licenseKey
      );

    if (!license) {
      return res.status(404).json({
        ok:
          false,

        error:
          "Invalid license"
      });
    }

    if (
      license.status !==
      "active"
    ) {
      return res.status(403).json({
        ok:
          false,

        error:
          "License disabled"
      });
    }

    if (
      new Date(
        license.expiresAt
      ) <= new Date()
    ) {
      license.status =
        "expired";

      save(data);

      return res.status(403).json({
        ok:
          false,

        error:
          "License expired"
      });
    }

    if (
      license.deviceId &&
      deviceId &&
      license.deviceId !==
      deviceId
    ) {
      return res.status(409).json({
        ok:
          false,

        error:
          "Device mismatch"
      });
    }

    return res.json({
      ok:
        true,

      license: {
        id:
          license.id,

        plan:
          license.plan,

        status:
          license.status,

        expiresAt:
          license.expiresAt
      }
    });
  }
);


/*
========================================================
ADMIN OVERVIEW
========================================================
*/

app.get(
  "/api/admin/overview",
  authAdmin,
  (req, res) => {
    const data =
      db();

    res.json({
      customers:
        data.customers.length,

      activeLicenses:
        data.licenses.filter(
          x =>
            x.status ===
              "active" &&
            new Date(
              x.expiresAt
            ) > new Date()
        ).length,

      revenue:
        data.payments
          .filter(
            x =>
              x.status ===
              "paid"
          )
          .reduce(
            (sum, x) =>
              sum +
              Number(
                x.usd ||
                0
              ),
            0
          ),

      payments:
        data.payments,

      customersList:
        data.customers,

      c2bTransactions:
        data.c2bTransactions || [],

      licenses:
        data.licenses.map(
          x => ({
            ...x,

            customer:
              data.customers.find(
                c =>
                  c.id ===
                  x.customerId
              )?.email ||
              x.email
          })
        )
    });
  }
);


/*
========================================================
ADMIN CREATE LICENSE
========================================================
*/

app.post(
  "/api/admin/license",
  authAdmin,
  (req, res) => {
    const {
      name,
      email,
      plan,
      product = "studypool"
    } =
      req.body;

    if (
      !name ||
      !email ||
      !PLANS[plan] ||
      !["studypool", "essaypro"].includes(String(product).toLowerCase())
    ) {
      return res.status(400).json({
        error:
          "Invalid details"
      });
    }

    const customer =
      upsertCustomer(
        name,
        email,
        ""
      );

    const license =
      createLicense(
        customer,
        plan,
        "MANUAL-" +
          id("PAY"),
        String(product).toLowerCase()
      );

    return res.json({
      ok:
        true,

      license
    });
  }
);


/*
========================================================
ADMIN TOGGLE LICENSE
========================================================
*/

app.post(
  "/api/admin/license/:id/toggle",
  authAdmin,
  (req, res) => {
    const data =
      db();

    const license =
      data.licenses.find(
        x =>
          x.id ===
          req.params.id
      );

    if (!license) {
      return res.status(404).json({
        error:
          "License not found"
      });
    }

    license.status =
      license.status ===
      "active"
        ? "disabled"
        : "active";

    save(data);

    return res.json({
      ok:
        true,

      status:
        license.status
    });
  }
);


/*
========================================================
ADMIN RESET DEVICE
========================================================
*/

app.post(
  "/api/admin/license/:id/reset-device",
  authAdmin,
  (req, res) => {
    const data =
      db();

    const license =
      data.licenses.find(
        x =>
          x.id ===
          req.params.id
      );

    if (!license) {
      return res.status(404).json({
        error:
          "License not found"
      });
    }

    license.deviceId =
      null;

    save(data);

    return res.json({
      ok:
        true
    });
  }
);


/*
========================================================
ADMIN EXTEND LICENSE
========================================================
*/

app.post(
  "/api/admin/license/:id/extend",
  authAdmin,
  (req, res) => {
    const data =
      db();

    const license =
      data.licenses.find(
        x =>
          x.id ===
          req.params.id
      );

    if (!license) {
      return res.status(404).json({
        error:
          "License not found"
      });
    }

    const base =
      new Date(
        license.expiresAt
      ) > new Date()
        ? new Date(
            license.expiresAt
          )
        : new Date();

    base.setDate(
      base.getDate() +
      30
    );

    license.expiresAt =
      base.toISOString();

    license.status =
      "active";

    save(data);

    return res.json({
      ok:
        true,

      expiresAt:
        license.expiresAt
    });
  }
);


/*
========================================================
ADMIN PAGE
========================================================
*/

app.get(
  "/admin",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "admin.html"
      )
    );
  }
);


/*
========================================================
START SERVER
========================================================
*/

const PORT =
  Number(
    process.env.PORT ||
    3000
  );

app.listen(
  PORT,
  () => {
    console.log(
      `BidPilot running on port ${PORT}`
    );

    console.log(
      "M-PESA ENV:",
      process.env.MPESA_ENV ||
        "sandbox"
    );

    console.log(
      "M-PESA SHORTCODE:",
      getShortcode()
    );

    console.log(
      "M-PESA PARTY B:",
      getPartyB()
    );

    console.log(
      "M-PESA CALLBACK:",
      getMpesaCallbackUrl()
    );
  }
);
