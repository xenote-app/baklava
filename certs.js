const
  { certsDir } = require('./config'),
  { execSync } = require('child_process'),
  fs = require('fs');

function createCerts() {
  console.log('\n🔐 Starting certificate generation process...\n');

  // Create certs directory if it doesn't exist
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir);
  } else {
    console.log('"" folder already exists. Remove this folder to continue.');
    return;
  }

  try {
    console.log('📝 Generating private key...');
    execSync(`openssl genrsa -out ${certsDir}/private-key.pem 2048`);
    
    console.log('📝 Generating CSR (Certificate Signing Request)...');
    execSync(`openssl req -new -key ${certsDir}/private-key.pem -out ${certsDir}/csr.pem -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"`);
    
    console.log('📝 Generating self-signed certificate...');
    execSync(`openssl x509 -req -days 365 -in ${certsDir}/csr.pem -signkey ${certsDir}/private-key.pem -out ${certsDir}/certificate.pem`);

    // List generated files
    const files = fs.readdirSync(certsDir);
    console.log('\n✅ Certificates generated successfully!');
    console.log('\n📂 Generated files in', certsDir);

  } catch (error) {
    console.error('\n❌ Error generating certificates:', error.message);
    process.exit(1);
  }  
}


module.exports = { createCerts }