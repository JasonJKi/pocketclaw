module.exports = {
  apps: [
    {
      name: "pocketclaw",
      script: "dist/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: "./logs/out.log",
      error_file: "./logs/err.log",
      time: true,
    },
  ],
};
