'use strict';

const SAFE_TRUST_PROXY = /^(loopback|linklocal|uniquelocal|[0-9a-fA-F:./,\s-]+)$/;

function validateProductionTransport({ nodeEnv, nativeTls, trustedProxy, insecureBypass }) {
  if (nodeEnv !== 'production') return;
  if (insecureBypass) throw new Error('ALLOW_INSECURE_NO_AUTH is not allowed in production');
  if (!nativeTls && !trustedProxy) {
    throw new Error('Production requires SSL_CERT/SSL_KEY or a configured TRUSTED_PROXY');
  }
  if (trustedProxy && !SAFE_TRUST_PROXY.test(trustedProxy)) {
    throw new Error('TRUSTED_PROXY must contain only known proxy addresses, CIDRs or Express aliases');
  }
}

module.exports = { validateProductionTransport };
