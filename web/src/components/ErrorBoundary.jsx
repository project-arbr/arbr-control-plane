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
          <h2 className="mb-2 text-xl font-semibold text-gray-900">
            Something went wrong on this page
          </h2>
          <p className="mb-6 text-sm text-gray-500">
            The application encountered an unexpected error while rendering.
          </p>
          <Link
            to="/"
            onClick={() => this.setState({ hasError: false })}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
          >
            Return to Overview
          </Link>
        </div>
      );
    }

    return this.props.children;
  }
}
