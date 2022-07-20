const
  express = require('express'),
  { fetchUsers, setPassword, checkPassword } = require('./helpers/password');

class AuthServer {
  constructor() {
    const router = this.router = express.Router();

    router.post('/login', (req, res) => {
      try {
        const { username, password } = req.body;
        if (!checkPassword({ username, password }))
          return res.status(401).send('Wrong username and password');
      } catch(e) {
        return res.status(401).send('Invalid arguments')        
      }
      req.session.authenticated = true;
      res.status(204).end();
    });

    router.post('/logout', (req, res) => {
      req.session.authenticated = false;
      res.status(204).end();
    });

    router.get('/users', (req, res) => {
      if (!req.session.authenticated)
        res.status(401).send('Unauthorized');
      res.send(fetchUsers());
    });

    router.post('/users', (req, res) => {
      if (!req.session.authenticated)
        res.status(401).send('Unauthorized');
      try {
        const { username, password } = req.body;
        setPassword({ username, password });
      } catch (e) {
        res.send(400).send('Bad Input');
      }
    });
  }
}

module.exports = AuthServer;