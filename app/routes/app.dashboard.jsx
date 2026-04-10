import { useLoaderData } from "react-router-dom";

export default function Dashboard() {
  const data = useLoaderData();

  return (
    <div>
      <h2>Customers</h2>

      {data?.map(item => (
        <div key={item.id}>
          {item.name} - {item.product}
        </div>
      ))}
    </div>
  );
}