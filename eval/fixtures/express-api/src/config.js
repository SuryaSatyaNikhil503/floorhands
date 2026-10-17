export const config = {
  port: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5432/shop',
  jwtSecret: process.env.JWT_SECRET || 'shop-signing-key-placeholder-0000',
  tokenTtl: '12h',
};
