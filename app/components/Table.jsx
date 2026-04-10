import PropTypes from "prop-types";

export default function Table({ data }) {
  return (
    <table>
      <tbody>
        {data.map(row => (
          <tr key={row.id}>
            <td>{row.name}</td>
            <td>{row.product}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ✅ Add this
Table.propTypes = {
  data: PropTypes.array.isRequired,
};