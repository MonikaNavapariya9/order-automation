export async function createShopifyCustomer(admin, user) {
  const res = await admin.graphql(`
    mutation {
      customerCreate(input:{
        email:"${user.email}",
        firstName:"${user.name}",
        phone:"${user.phone}"
      }) {
        customer { id }
      }
    }
  `);

  return res.data.customerCreate.customer.id;
}

export async function createDraftOrder(admin, user, customerId) {
  const res = await admin.graphql(`
    mutation {
      draftOrderCreate(input:{
        customerId:"${customerId}",
        tags:["partner:${user.partner}"],
        lineItems:[{
          title:"${user.product}",
          quantity:${user.qty},
          originalUnitPrice:${user.deposit}
        }]
      }) {
        draftOrder { id invoiceUrl }
      }
    }
  `);

  return res.data.draftOrderCreate.draftOrder;
}