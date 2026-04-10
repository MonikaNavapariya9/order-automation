import { db } from "./db.server";

export async function createCustomer(data) {
  const { email, name, phone, address, product, qty, deposit, state, partner } = data;

  await db.execute(
    `INSERT INTO customers 
    (email,name,phone,address,product,qty,deposit,state,partner)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [email, name, phone, address, product, qty, deposit, state, partner]
  );
}

export async function getPendingCustomers() {
  const [rows] = await db.execute(`SELECT * FROM customers WHERE status='pending'`);
  return rows;
}

export async function getCustomerById(id) {
  const [rows] = await db.execute(`SELECT * FROM customers WHERE id=?`, [id]);
  return rows[0];
}