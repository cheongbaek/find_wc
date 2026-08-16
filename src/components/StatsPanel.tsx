import { Fragment } from "react";

export interface StatSection {
  title: string;
  rows: { label: string; value: string }[];
}

export default function StatsPanel({ sections }: { sections: StatSection[] }) {
  if (!sections.length) return null;
  return (
    <table className="stats">
      <tbody>
        {sections.map((section) => (
          <Fragment key={section.title}>
            <tr className="sec">
              <th colSpan={2}>{section.title}</th>
            </tr>
            {section.rows.map((row) => (
              <tr key={row.label}>
                <th>{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
