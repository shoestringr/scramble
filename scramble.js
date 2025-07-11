const COMPRESSION_ALGORITHM = 'deflate';
const PASSWORD_SALT = new Uint32Array([0xb6db27dd, 0xa7e64336, 0x7ec91eba, 0x503563c3]);
const PASSWORD_DIGESTS = new Set([
  // 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',  // empty string (testing only)
  // '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',  // 'password' (testing only)
  '9f4da28adb6ebdeeede0d057a11f85a4c74821ba2ed5963e6607765b25a59fa0',
]);
const PBKDF2_ITERATIONS = 8675309;

const searchParams = new URLSearchParams(window.location.search);
/** @type {HTMLTextAreaElement} */(document.getElementById('ciphertext')).value =
  searchParams.get('data') || '';

const textEncoder = new TextEncoder();

new Promise((resolve, reject) => {
  let password = '';

  const deriveButton = /** @type {HTMLButtonElement} */
    (document.getElementById('derive-button'));

  document.getElementById('password').addEventListener('input', async event => {
    const input = /** @type {HTMLInputElement} */(event.target);
    password = input.value;

    deriveButton.disabled = !await isValidPassword(password);
  });

  const setupDialog = /** @type {HTMLDialogElement} */
    (document.getElementById('setup-dialog'));

  deriveButton.addEventListener('click', async event => {
    event.preventDefault();
    deriveButton.disabled = true;
    
    try {
      const key = await deriveKeyFromPassword(password, PBKDF2_ITERATIONS);
      resolve(key);
      setupDialog.close();
    } catch (e) {
      reject(e);
      log(`Key derivation failed: ${e.message}`);
    } finally {
      /** @type {HTMLInputElement} */(document.getElementById('password')).value = '';
    }
  });

  // @ts-ignore
  setupDialog.showModal();
}).then((/** @type {CryptoKey} */ key) => {
  document.getElementById('plaintext').addEventListener('input', async event => {
    const textarea = /** @type {HTMLTextAreaElement} */(event.target);
    const plaintext = textarea.value;
    const output = /** @type {HTMLTextAreaElement} */(document.getElementById('ciphertext'));
    log();
    try {
      const compressed = await compressString(plaintext);
      const ciphertext = await encrypt(key, compressed);
      output.value = toBase64Url(ciphertext);

      // Update the URL with the ciphertext.
      const url = new URL(location.href);
      url.searchParams.set('data', output.value);
      history.replaceState({}, '', url.toString());
      log(`URL updated (${url.href.length} characters)`);
    } catch (e) {
      output.value = '';
      history.replaceState({}, '', location.pathname);
      log(`Encryption failed: ${e.message}`);
    }
  });

  document.getElementById('ciphertext').addEventListener('input', async event => {
    const textarea = /** @type {HTMLTextAreaElement} */(event.target);
    if (textarea.value) {
      const ciphertext = fromBase64Url(textarea.value);
      const output = /** @type {HTMLTextAreaElement} */(document.getElementById('plaintext'));
      log();
      try {
        const compressed = await decrypt(key, ciphertext);
        const plaintext = await decompressString(compressed);
        output.value = plaintext;
      } catch (e) {
        output.value = '';
        log(`Decryption failed: ${e.message}`);
      }
    }
  });

  document.getElementById('ciphertext').dispatchEvent(new Event('input'));
});

/**
 * Derives a key from the given password using PBKDF2.
 * @param {string} password The password to derive the key from.
 * @param {number} nIterations The number of iterations for the key derivation.
 * @returns {Promise<CryptoKey>} A promise that resolves to the derived key.
 */
async function deriveKeyFromPassword(password, nIterations) {
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: PASSWORD_SALT,
      iterations: nIterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * @param {string} password
 * @returns {Promise<boolean>} True if the password is valid, false otherwise.
 */
async function isValidPassword(password) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(password));
  const hex = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (PASSWORD_DIGESTS.has(hex)) {
    return true;
  }
  console.log(`Password digest: ${hex}`);
  return searchParams.has('test');
}

/**
 * Compress a string using the Compression Streams API.
 * @param {string} s 
 * @returns {Promise<ArrayBuffer>} Compressed string as an ArrayBuffer.
 */
async function compressString(s) {
  const chunks = [];
  await new ReadableStream({
    start(controller) {
        controller.enqueue(textEncoder.encode(s));
        controller.close();
    }
  }).pipeThrough(
    new CompressionStream(COMPRESSION_ALGORITHM)
  ).pipeTo(
    new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      }
    })
  );
  return new Blob(chunks).arrayBuffer();
}

/**
 * Decompress a string using the Compression Streams API.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>} Decompressed string.
 */
async function decompressString(buffer) {
  const chunks = [];
  await new ReadableStream({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    }
  }).pipeThrough(
    new DecompressionStream(COMPRESSION_ALGORITHM)
  ).pipeTo(
    new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      }
    })
  );
  return new Blob(chunks).text();
}

/**
 * Encrypt with AES-GCM.
 * @param {CryptoKey} key The key to use for encryption.
 * @param {ArrayBuffer} plaintext
 * @returns {Promise<string>} Encrypted data as base64.
 */
async function encrypt(key, plaintext) {
  // Generate random initialization vector.
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
    },
    key,
    plaintext
  );

  // Prepend the IV to the ciphertext.
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(ciphertext)));
};

/**
 * Decrypt with AES-GCM.
 * @param {CryptoKey} key The key to use for decryption.
 * @param {string} base64
 * @returns {Promise<ArrayBuffer>} Decrypted data.
 */
async function decrypt(key, base64) {
  const ciphertext = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const plaintext = await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: ciphertext.slice(0, 12),
    },
    key,
    ciphertext.slice(12)
  );
  return plaintext
}

/**
 * Convert a base64 string to base64url.
 * @param {string} base64 The base64 string to convert.
 * @returns {string} The base64url encoded string.
 */
function toBase64Url(base64) {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Convert a base64url string to base64.
 * @param {string} base64url The base64url string to convert.
 * @returns {string} The base64 encoded string.
 */
function fromBase64Url(base64url) {
  return base64url.replace(/-/g, '+').replace(/_/g, '/') +
   '=='.slice(0, (4 - base64url.length % 4) % 4);
}

function log(...args) {
  const logElement = document.getElementById('log');
  logElement.textContent = args.join(' ');
  if (args.length > 0) {
    console.log(...args);
  }
}