import express from 'express';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import orderRoutes from './routes/orders.js';
import productRoutes from './routes/products.js';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));
app.use(authRoutes);
app.use(productRoutes);
app.use(orderRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message, stack: err.stack });
});

app.listen(config.port, () => console.log(`shop-api listening on ${config.port}`));
