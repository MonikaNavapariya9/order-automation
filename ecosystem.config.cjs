module.exports = {
  apps: [
    {
      name: "shopify-app",
      cwd: "/home/ubuntu/order-automation/order-automation",
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    }
  ]
};
