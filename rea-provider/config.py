    'REA_KUNA_AUTO_ANALYSIS_MODE': True,
    'REA_KUNA_AUTO_ANALYSIS_LIMIT': 1000,
    'REA_KUNA_EVIDENCE_SCHEMA_VERSION': 2,
        {
            'name': 'auto_analysis_mode',
            'type': 'boolean',
            'description': 'Enable automatic analysis mode.'
        },
        {
            'name': 'auto_analysis_limit',
            'type': 'integer',
            'description': 'Limit for automatic analysis.'
        },
        {
            'name': 'timeout_ms',
            'type': 'integer',
            'description': 'Deadline for one single-function decompile.'
        },
        {
            'name': 'unsupported_targets',
            'type': 'list',
            'description': 'Unsupported targets.'
        },
        {
            'name': 'max_heap_size',
            'type': 'integer',
            'description': 'Total heap size.'
        },
    ]
}
