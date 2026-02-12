# Baklava - Process Manager for Notebook

Baklava is a tool for connecting your notebook frontend with a powerful backend. It makes it easy to sync files, run code, and stay in touch with your backend processes - all from within your notebook.

With Baklava, you can effortlessly run code written in languages like Python, C, Java, or Rust, no matter where you are. Install it on any operating system, run it in a sandbox environment, and connect remotely via your notebook.

### In a nutshell

- Sync files seamlessly from the Notebook
- Run processes remotely
- Get back the streamed standard outputs
- Use Vani, a real-time communication channel, between the processes and the Notebook


### Install and Run

1. Install directly via npm `npm install -g xenote-baklava`
2. Create a `sandbox` folder at a safe location
3. Change into the sandbox folder, and initialize it with `baklava init`
4. Launch using `baklava launch`
5. Connect using the Notebook

Note: The default port for HTTP is 3456 and HTTPS is 3457

### Use HTTPS from anywhere
Due to browser security, you cannot to connect `xenote.com` to a port/domain that is not `localhost`. To override this behavior you could do one of two things.

#### 1. Use `cloudflared` or `ngrok`
  Ngrok create a HTTPS link that is accessible throught the internet.
  A command `ngrok http 3456` will create a https forwarding to the http port.
  This link can be accessed via internet.

#### 2. Create Unsigned SSL
  - Use command 'baklava create-cert', This will create an unsigned SSL Certificate.
  - Lets say your ip is `10.10.10.10`, Navitate to `https://10.10.10.10:3457` on a new tab. You will reach the security screen.
  - On the 'Click "Advanced" Click "Proceed to site" (Chrome) or "Accept the Risk" (Firefox)
  - Go back to the the notebook and try to connect again.


### Overriding "config"
- If you want to use different port you could create a new file called "config.json", and override the config variables. The default variables are:
`{
  httpPort: 3456,
  httpsPort: 3457,
  vaniPort: 3458,
  mcpPort: 3459,
  certsDir: './_certs'
}`
