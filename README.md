# Baklava - Process Manager for Notebook

Baklava is a tool for connecting your notebook frontend with a powerful backend. It makes it easy to sync files, run code, and stay in touch with your backend processes - all from within your notebook.

With Baklava, you can effortlessly run code written in languages like Python, C, Java, or Rust, no matter where you are. Install it on any operating system, run it in a sandbox environment, and connect remotely via your notebook.

### In a nutshell

- Sync files seamlessly from the Notebook
- Run processes remotely
- Get back the streamed standard outputs
- Use Vani, a real-time communication channel, between the processes and the Notebook


### Install and Run

1. Clone baklava `git clone https://github.com/xenote-app/baklava.git`
2. Change into the baklava folder `cd baklava`
3. Install dependencies `npm install` and then install the app globally  `npm install -g`
4. Create a `sandbox` folder somewhere
5. Change into the sandbox folder and launch using `baklava launch`
6. Connect using the Notebook.

Note: The default port for HTTP is 3456 and HTTPS is 3444

### Allow HTTPS
Due to browser security, you cannot to connect `xenote.com` to a port/domain that is not `localhost`. To override this behavior you could do one of two things.

#### 1. Use ngrok.
  Ngrok create a HTTPS link that is accessible throught the internet.
  A command `ngrok http 3456` will create a https forwarding to the http port.
  This link can be accessed via internet.

#### 2. Create Unsigned SSL
  - Use command 'baklava create-cert', This will create an unsigned SSL Certificate.
  - Lets say your ip is `10.10.10.10`, Navitate to `https://10.10.10.10:3444` on a new tab. You will reach the security screen.
  - On the 'Click "Advanced" Click "Proceed to site" (Chrome) or "Accept the Risk" (Firefox)
  - Go back to the the notebook and try to connect again.


### Overriding "config"
- If you want to use different port you could create a new file called "config.json", and override variables. The default variables are:
`{
  httpPort: 3456,
  httpsPort: 3444,
  vaniPort: 3434,
  certsDir: './_certs'
}`
