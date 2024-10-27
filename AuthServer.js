const
  express = require('express'),
  jwt = require('jsonwebtoken'),
  config = require('./config'),
  { fetchUsernames, deleteUsername, setPassword, checkPassword } = require('./helpers/password');

class AuthServer {
  constructor() {
    const router = this.router = express.Router();

    router.post('/login', function(req, res) {
      try {
        const { username, password } = req.body;
        if (!checkPassword({ username, password }))
          return res.status(401).send('Wrong username and password');

        const token = jwt.sign({ username: username }, config.secret);
        res.send({ token });
      } catch(e) {
        return res.status(401).send('Invalid arguments')        
      }
    });

    router.get('/whoami', function(req, res) {
      if (req.session && req.session.authenticated)
        res.status(200).send({username: req.session.username});
      else
        res.status(401).send('Unauthorized');
    });


    router.post('/logout', function(req, res) {
      req.session.authenticated = false;
      res.status(204).end();
    });

    router.get('/users', function(req, res) {
      if (!req.session.authenticated)
        res.status(401).send('Unauthorized');
      else
        res.send(fetchUsernames());
    });

    router.delete('/users/:username', function(req, res) {
      if (!req.session.authenticated || req.session.username === req.params.username)
        return res.status(401).send('Unauthorized');
      deleteUsername(req.params.username);
      res.status(204).end();
    });

    router.post('/users', function(req, res) {
      if (!req.session.authenticated) {
        res.status(401).send('Unauthorized');
        return;
      }
      try {
        const { username, password } = req.body;
        setPassword({ username, password });
        res.status(204).end();
      } catch (e) {
        // console.error(e);
        res.status(400).send('Bad Input');
      }
    });
  }
}

module.exports = AuthServer;