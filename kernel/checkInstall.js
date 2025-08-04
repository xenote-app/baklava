const { spawnSync } = require('child_process');

const defaultMinVersion = {
  IPython: '8.0.0',
  ipykernel: '6.29.5',
  // ipywidgets: '8.1.7',
  // jupyter_client: '8.6.3',
  // jupyter_core: '5.7.2',
  // jupyter_server: '2.15.0',
  // jupyterlab: '4.4.1',
  // nbclient: '0.10.2',
  // nbconvert: '7.16.6',
  // nbformat: '5.10.4',
  // notebook: '7.4.1',
  // qtconsole: 'not installed',
  // traitlets: '5.14.3',
};

/**
 * Checks if Jupyter is installed and meets version requirements
 * @param {Object} minVersions - Minimum versions required for each component
 * @returns {{installed: boolean, versions: Object, meetsMinVersion: boolean, issues: Array}}
 */
function checkInstall(minVersions = defaultMinVersion) {
  const zmqInstalled = !!require('./zmq');

  try {
    const result = spawnSync('jupyter', ['--version'], { encoding: 'utf8' });
    
    // Check if the command was successful
    if (result.error || result.status !== 0) {
      return {
        installed: false,
        versions: {},
        meetsMinVersion: false,
        issues: ['Jupyter is not installed or not in PATH']
      };
    }
    
    // Parse all versions from the multi-line output
    const output = result.stdout;
    const detectedVersions = {};
    const issues = [];
    
    output.split('\n').forEach(line => {
      const match = line.match(/^(.+?)\s+:\s+(.+?)$/);
      if (match) {
        const [, pkg, version] = match;
        const pkgName = pkg.trim();
        detectedVersions[pkgName] = version.trim();
      }
    });
    
    // Check if required components are installed and meet minimum versions
    let allMeetMinVersion = true;
    
    for (const [component, minVersion] of Object.entries(minVersions)) {
      const detectedVersion = detectedVersions[component];
      
      // Skip checking if no minimum version is specified or if it's explicitly set to 'not installed'
      if (minVersion === 'not installed') {
        continue;
      }
      
      // Component is missing
      if (!detectedVersion || detectedVersion === 'not installed') {
        if (minVersion !== 'not installed') {
          issues.push(`${component} is required but not installed`);
          allMeetMinVersion = false;
        }
        continue;
      }
      
      // Version is too low
      if (compareVersions(detectedVersion, minVersion) < 0) {
        issues.push(`${component} version ${detectedVersion} is lower than required ${minVersion}`);
        allMeetMinVersion = false;
      }
    }
    
    return {
      installed: true,
      versions: detectedVersions,
      meetsMinVersion: allMeetMinVersion,
      issues, zmqInstalled
    };
  } catch (error) {
    return {
      installed: false,
      versions: {},
      meetsMinVersion: false,
      issues: [error.message || 'Unknown error checking Jupyter installation'],
      zmqInstalled
    };
  }
}

/**
 * Compares version strings
 * @param {string} v1 - First version string
 * @param {string} v2 - Second version string
 * @returns {number} - Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    
    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }
  
  return 0;
}


// ANSI color codes - no external dependencies needed
function showInstallMessage(installStatus) {
  const { colors } = require('../helpers/colors');

  if (!installStatus.zmqInstalled) {
    console.log(
      colors.red + 
      'ZeroMQ package not available. Jupyter Kernel is disabled.' +
      colors.reset
    );
  }

  if (!installStatus.installed) {
    console.log(
      colors.red + '⨯ Jupyter not detected.'+
      colors.yellow + '\nTo use interactive Python kernel elements, you need to have Jupyter installed.' +
      '\nInstallation Guide: ' + colors.blue + colors.underline + 'https://jupyter.org/install' + colors.reset +
      '\n\n'
    );
  } else if (!installStatus.meetsMinVersion) {
    console.log(
      colors.yellow + '⚠ Jupyter version issue detected' + colors.reset +
      '\n\nThe following components need updating:'
    );
    // List issues with color coding
    installStatus.issues.forEach(issue => {
      console.log(colors.red + '  • ' + colors.reset + issue);
    });
    console.log('\n\n');
  } else {
    // console.log(colors.green + '✓ Jupyter is properly installed\n' + colors.reset);
  }
}

module.exports = { checkInstall, defaultMinVersion, showInstallMessage };