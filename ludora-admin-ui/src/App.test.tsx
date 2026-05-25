import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders the admin shell navigation', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: /Ludora Admin/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Store Candidates/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Listing Candidates/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review Tasks/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Items/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Offers/i })).toBeInTheDocument();
  });
});
