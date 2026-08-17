import React from "react";
import { Link } from "react-router-dom";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center p-8 text-center">
          <div className="mb-4 text-4xl">⚠️</div>
          <h2 className="mb-2 text-xl font-semibold text-arbr-charcoal">
            Something went wrong on this page
          </h2>
          <p className="mb-6 text-sm text-gray-500">
            The application encountered an unexpected error while rendering.
          </p>
          <Link
            to="/"
            onClick={() => this.setState({ hasError: false })}
            className="btn-secondary"
          >
            Return to Overview
          </Link>
        </div>
      );
    }

    return this.props.children;
  }
}
